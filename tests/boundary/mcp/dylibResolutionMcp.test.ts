import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { z } from "zod";

import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import {
  FILE_TYPE,
  LC,
  buildVersionCommand,
  dylibCommand,
  dyldEnvironmentCommand,
  machoImage,
  rpathCommand,
} from "../../../src/artifacts/apple/MachoImage.fixture.js";
import { dylibResolutionResultSchema } from "../../../src/domain/apple/dylibResolution.js";
import { createServer } from "../../../src/server/createServer.js";
import { createOwnedAppleStaticSession } from "../../../src/composition/OwnedAppleStaticSession.js";
import {
  attachOwnedFixturePolicy,
  digestOwnedFixtureInput,
  sealOwnedFixturePolicy,
} from "../../../src/application/investigationSafety/OwnedFixturePolicy.js";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { AppleStaticArtifactProvider } from "../../../src/artifacts/AppleStaticArtifactProvider.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

interface DeclaredFixture {
  readonly root: string;
  readonly directories: readonly string[];
  readonly files: readonly string[];
  readonly requests: readonly {
    readonly name: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }[];
}
const traceFixture = (
  root: string,
  inventory: Pick<DeclaredFixture, "directories" | "files">,
  path: string,
  traceRequests: DeclaredFixture["requests"] = [
    { name: "trace_dylib_resolution", arguments: {} },
  ],
): DeclaredFixture => ({
  root,
  ...inventory,
  requests: [{ name: "open_binary", arguments: { path } }, ...traceRequests],
});
const withClient = async (
  fixture: DeclaredFixture,
  verify: (client: Client) => Promise<void>,
): Promise<void> => {
  const session = createOwnedAppleStaticSession();
  const server = createServer(
    { kind: "session", session },
    { environment: {} },
  );
  const capability = "owned-apple-static-fixture";
  const portId = "controller-owned-apple-static-port";
  const files = await Promise.all(
    fixture.files.map(async (relative) => {
      const path = join(fixture.root, relative);
      return {
        path,
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
        role: "dependency" as const,
      };
    }),
  );
  const token = await sealOwnedFixturePolicy(
    {
      roots: [fixture.root],
      files,
      static_inventory: {
        directories: fixture.directories.map((path) =>
          join(fixture.root, path),
        ),
      },
      endpoints: [],
      environment: [],
      available_capabilities: [capability],
      grants: fixture.requests.map((request) => {
        const contract = TOOL_CONTRACTS.find(
          ({ name }) => name === request.name,
        );
        if (contract === undefined)
          throw new Error(`Unknown declared request ${request.name}`);
        return {
          operation: request.name,
          input_digest: digestOwnedFixtureInput(
            contract.inputSchema.parse(request.arguments),
          ),
          capability,
          mode: "owned-static" as const,
          port_id: portId,
        };
      }),
    },
    { owned_static_ports: [{ port_id: portId, reference: session }] },
  );
  attachOwnedFixturePolicy(server, token, session);
  const client = new Client({ name: "dylib-mcp-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await verify(client);
  } finally {
    await client.close();
    await server.close();
    expect(await session.close()).toEqual({ ok: true, value: null });
  }
};

/** Direct parser coverage for test-authored carriers that inventory admission rejects. */
const syntheticAppleError = async (
  path: string,
  parameters: Readonly<Record<string, JsonValue>>,
  app?: string,
  options: {
    readonly operation?: "trace_dylib_resolution" | "inspect_asset_catalog";
    readonly expectedDigest?: string;
  } = {},
) => {
  const operation = options.operation ?? "trace_dylib_resolution";
  const target = {
    path,
    ...(app === undefined
      ? {}
      : { sourcePath: app, bundleInfoPlist: join(app, "Contents/Info.plist") }),
    sha256:
      options.expectedDigest ??
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    ...(path.endsWith(".plist")
      ? { kind: "artifact" as const, format: "plist" as const }
      : {
          kind: "executable" as const,
          format: "mach-o" as const,
          architecture: "arm64" as const,
          availableArchitectures: ["arm64" as const],
        }),
  };
  const provider =
    operation === "inspect_asset_catalog"
      ? new ArtifactProvider({})
      : new AppleStaticArtifactProvider();
  const client = provider.createClient(target);
  try {
    const result = await client.execute(operation, parameters);
    if (result.ok) throw new Error("Expected synthetic parser rejection");
    return projectAnalysisError(result.error);
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
};

const structuredResult = (value: unknown): unknown =>
  z.object({ normalized_result: z.unknown() }).parse(value).normalized_result;

it("traces dylib resolution for an opened app bundle and rejects a changed target", async () => {
  const app = join(
    await createTestTempDirectory("rea-dylib-mcp-"),
    "Fixture.app",
  );
  await mkdir(join(app, "Contents/MacOS"), { recursive: true });
  await mkdir(join(app, "Contents/Frameworks"), { recursive: true });
  await writeFile(
    join(app, "Contents/Info.plist"),
    "<plist><dict><key>CFBundleExecutable</key><string>App</string></dict></plist>",
  );
  const executable = join(app, "Contents/MacOS/App");
  await writeFile(
    executable,
    machoImage({
      commands: [
        buildVersionCommand(1),
        rpathCommand("@executable_path/../Frameworks"),
        dylibCommand(LC.LOAD_DYLIB, "@rpath/libcore.dylib"),
      ],
    }),
  );
  await writeFile(
    join(app, "Contents/Frameworks/libcore.dylib"),
    machoImage({
      fileType: FILE_TYPE.dylib,
      commands: [buildVersionCommand(1)],
    }),
  );
  await withClient(
    traceFixture(
      app,
      {
        directories: ["Contents", "Contents/MacOS", "Contents/Frameworks"],
        files: [
          "Contents/Info.plist",
          "Contents/MacOS/App",
          "Contents/Frameworks/libcore.dylib",
        ],
      },
      app,
    ),
    async (client) => {
      const opened = await client.callTool({
        name: "open_binary",
        arguments: { path: app },
      });
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      const called = await client.callTool({
        name: "trace_dylib_resolution",
        arguments: {},
      });
      expect(called.isError, JSON.stringify(called.structuredContent)).not.toBe(
        true,
      );
      const trace = dylibResolutionResultSchema.parse(
        structuredResult(called.structuredContent),
      );
      expect(trace.edges).toEqual([
        expect.objectContaining({
          install_name: "@rpath/libcore.dylib",
          resolution: {
            status: "resolved",
            image: "Contents/Frameworks/libcore.dylib",
          },
        }),
      ]);
      const escaping = await client.callTool({
        name: "trace_dylib_resolution",
        arguments: { roots: ["Contents/../../outside"] },
      });
      expect(escaping.isError).toBe(true);

      const expectedDigest = createHash("sha256")
        .update(await readFile(executable))
        .digest("hex");
      await writeFile(executable, machoImage({}));
      const changed = await client.callTool({
        name: "trace_dylib_resolution",
        arguments: {},
      });
      expect(changed.isError).toBe(true);
      expect(parseMcpToolError(changed)).toMatchObject({
        error: { code: "capability_unavailable" },
      });
      expect(
        JSON.stringify(
          await syntheticAppleError(executable, {}, app, {
            operation: "trace_dylib_resolution",
            expectedDigest,
          }),
        ),
      ).toContain("integrity");
    },
  );
});

it("rejects targets that are not Mach-O", async () => {
  const directory = await createTestTempDirectory("rea-dylib-mcp-plist-");
  const path = join(directory, "Info.plist");
  await writeFile(path, "<plist><dict/></plist>");
  await withClient(
    traceFixture(directory, { directories: [], files: ["Info.plist"] }, path),
    async (client) => {
      const opened = await client.callTool({
        name: "open_binary",
        arguments: { path },
      });
      expect(opened.isError).not.toBe(true);
      const called = await client.callTool({
        name: "trace_dylib_resolution",
        arguments: {},
      });
      expect(called.isError).toBe(true);
      expect(parseMcpToolError(called)).toMatchObject({
        error: { code: "unsupported_target", category: "unsupported_target" },
      });
    },
  );
});

it("reports target kinds that artifact operations cannot inspect as unsupported", async () => {
  const directory = await createTestTempDirectory("rea-artifact-target-");
  const plist = join(directory, "Info.plist");
  await writeFile(plist, "<plist><dict/></plist>");
  const tool = join(directory, "tool");
  await writeFile(tool, machoImage({ commands: [buildVersionCommand(1)] }));
  await withClient(
    {
      root: directory,
      directories: [],
      files: ["Info.plist", "tool"],
      requests: [
        { name: "open_binary", arguments: { path: plist } },
        { name: "open_binary", arguments: { path: tool } },
        { name: "decode_interface_builder", arguments: {} },
        { name: "inspect_keyed_archive", arguments: {} },
      ],
    },
    async (client) => {
      for (const [path, operation, requirement] of [
        [plist, "decode_interface_builder", "requires an active .app bundle"],
        // Elsewhere the session reports asset catalogs as unavailable on the
        // host before the provider checks the target kind.
        ...(process.platform === "darwin"
          ? ([
              [
                plist,
                "inspect_asset_catalog",
                "requires an active .app bundle",
              ],
            ] as const)
          : []),
        [tool, "inspect_keyed_archive", "requires an active plist or .app"],
      ] as const) {
        const open = { name: "open_binary", arguments: { path } };
        expect((await client.callTool(open)).isError, path).not.toBe(true);
        const called = await client.callTool({
          name: operation,
          arguments: {},
        });
        if (operation === "inspect_asset_catalog") {
          expect(parseMcpToolError(called)).toMatchObject({
            error: { code: "capability_unavailable" },
          });
          expect({
            error: await syntheticAppleError(path, {}, undefined, {
              operation,
            }),
          }).toMatchObject({
            error: {
              code: "unsupported_target",
              message: expect.stringContaining(`${operation} at ${path}`),
              details: { reason: expect.stringContaining(requirement) },
            },
          });
          continue;
        }
        expect(parseMcpToolError(called), operation).toMatchObject({
          error: {
            code: "unsupported_target",
            message: expect.stringContaining(`${operation} at ${path}`),
            details: { reason: expect.stringContaining(requirement) },
          },
        });
      }
    },
  );
});

it("traces a standalone Mach-O file whose name ends in .app", async () => {
  const directory = await createTestTempDirectory("rea-dylib-mcp-file-");
  await writeFile(
    join(directory, "Tool.app"),
    machoImage({
      commands: [
        buildVersionCommand(1),
        dylibCommand(LC.LOAD_DYLIB, "@loader_path/libcore.dylib"),
      ],
    }),
  );
  await writeFile(
    join(directory, "libcore.dylib"),
    machoImage({
      fileType: FILE_TYPE.dylib,
      commands: [buildVersionCommand(1)],
    }),
  );
  await withClient(
    traceFixture(
      directory,
      { directories: [], files: ["Tool.app", "libcore.dylib"] },
      join(directory, "Tool.app"),
    ),
    async (client) => {
      const opened = await client.callTool({
        name: "open_binary",
        arguments: { path: join(directory, "Tool.app") },
      });
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      const called = await client.callTool({
        name: "trace_dylib_resolution",
        arguments: {},
      });
      expect(called.isError, JSON.stringify(called.structuredContent)).not.toBe(
        true,
      );
      const trace = dylibResolutionResultSchema.parse(
        structuredResult(called.structuredContent),
      );
      expect(trace.edges).toEqual([
        expect.objectContaining({
          resolution: { status: "resolved", image: "libcore.dylib" },
        }),
      ]);
    },
  );
});

it.skipIf(process.getuid?.() === 0)(
  "keeps a permission denied while canonicalizing the opened bundle",
  async () => {
    const parent = await createTestTempDirectory("rea-dylib-mcp-revoked-");
    const app = join(parent, "Revoked.app");
    await mkdir(join(app, "Contents/MacOS"), { recursive: true });
    await writeFile(
      join(app, "Contents/Info.plist"),
      "<plist><dict><key>CFBundleExecutable</key><string>App</string></dict></plist>",
    );
    await writeFile(join(app, "Contents/MacOS/App"), machoImage({}));
    await withClient(
      traceFixture(
        app,
        {
          directories: ["Contents", "Contents/MacOS"],
          files: ["Contents/Info.plist", "Contents/MacOS/App"],
        },
        app,
      ),
      async (client) => {
        const opened = await client.callTool({
          name: "open_binary",
          arguments: { path: app },
        });
        expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
        const executable = join(app, "Contents/MacOS/App");
        const expectedDigest = createHash("sha256")
          .update(await readFile(executable))
          .digest("hex");
        await chmod(parent, 0o000);
        try {
          const called = await client.callTool({
            name: "trace_dylib_resolution",
            arguments: {},
          });
          expect(called.isError).toBe(true);
          expect(parseMcpToolError(called)).toMatchObject({
            error: { code: "capability_unavailable" },
          });
          expect(
            JSON.stringify(
              await syntheticAppleError(executable, {}, app, {
                operation: "trace_dylib_resolution",
                expectedDigest,
              }),
            ),
          ).toMatch(/Permission denied \(EACCES\)/u);
        } finally {
          await chmod(parent, 0o755);
        }
      },
    );
  },
);

it.each([
  "DYLD_LIBRARY_PATH=/external",
  "DYLD_PRINT_RPATHS=1",
  "DYLD_FALLBACK_LIBRARY_PATH=/external",
  "DYLD_FRAMEWORK_PATH=/external",
  "DYLD_ROOT_PATH=/external",
  "DYLD_OVERLAY_PATH=/external",
])("preserves %s and its resolution semantics through MCP", async (setting) => {
  const root = await createTestTempDirectory("rea-dylib-environment-mcp-");
  const program = join(root, "program");
  await writeFile(
    program,
    machoImage({
      commands: [
        dyldEnvironmentCommand(setting),
        buildVersionCommand(1),
        dylibCommand(LC.LOAD_DYLIB, "@loader_path/child.dylib"),
      ],
    }),
  );
  await writeFile(
    join(root, "child.dylib"),
    machoImage({
      fileType: FILE_TYPE.dylib,
      commands: [buildVersionCommand(1)],
    }),
  );
  await withClient(
    traceFixture(
      root,
      { directories: [], files: ["program", "child.dylib"] },
      program,
    ),
    async (client) => {
      const opened = await client.callTool({
        name: "open_binary",
        arguments: { path: program },
      });
      expect(opened.isError).not.toBe(true);
      const result = await client.callTool({
        name: "trace_dylib_resolution",
        arguments: {},
      });
      expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(
        true,
      );
      const trace = dylibResolutionResultSchema.parse(
        structuredResult(result.structuredContent),
      );
      const overrides = setting.startsWith("DYLD_LIBRARY_PATH=");
      expect(trace.edges[0]?.resolution.status).toBe(
        overrides ? "conditional" : "resolved",
      );
      expect(trace.coverage.status).toBe(overrides ? "partial" : "complete");
      expect(
        trace.images.find(({ path }) => path === "program")?.slices[0]
          ?.dyld_environment,
      ).toEqual([setting]);
    },
  );
});

it("ignores process settings on an explicitly selected library root through MCP", async () => {
  const root = await createTestTempDirectory("rea-dylib-root-mcp-");
  const path = join(root, "library.dylib");
  const settings = [
    "DYLD_LIBRARY_PATH=/external",
    "DYLD_INSERT_LIBRARIES=/external/injected.dylib",
  ];
  await writeFile(
    path,
    machoImage({
      fileType: FILE_TYPE.dylib,
      commands: [
        buildVersionCommand(1),
        ...settings.map(dyldEnvironmentCommand),
        dylibCommand(LC.LOAD_DYLIB, "@loader_path/child.dylib"),
        dylibCommand(LC.LOAD_DYLIB, "@loader_path/missing.dylib"),
      ],
    }),
  );
  await writeFile(
    join(root, "child.dylib"),
    machoImage({
      fileType: FILE_TYPE.dylib,
      commands: [buildVersionCommand(1)],
    }),
  );
  await withClient(
    traceFixture(
      root,
      { directories: [], files: ["library.dylib", "child.dylib"] },
      path,
      [
        {
          name: "trace_dylib_resolution",
          arguments: { roots: ["library.dylib"] },
        },
      ],
    ),
    async (client) => {
      const opened = await client.callTool({
        name: "open_binary",
        arguments: { path },
      });
      expect(opened.isError, JSON.stringify(opened.structuredContent)).not.toBe(
        true,
      );
      const result = await client.callTool({
        name: "trace_dylib_resolution",
        arguments: { roots: ["library.dylib"] },
      });
      expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(
        true,
      );
      const trace = dylibResolutionResultSchema.parse(
        structuredResult(result.structuredContent),
      );
      expect(trace.edges.map(({ resolution }) => resolution.status)).toEqual([
        "resolved",
        "unresolved",
      ]);
      expect(trace.coverage.status).toBe("complete");
      expect(trace.findings.map(({ kind }) => kind)).toContain(
        "required-load-unresolved",
      );
      expect(
        trace.images.find(({ path }) => path === "library.dylib")?.slices[0]
          ?.dyld_environment,
      ).toEqual(settings);
      expect(
        trace.findings.find(({ kind }) => kind === "dyld-environment-present")
          ?.explanation,
      ).toContain("entries in this non-executable root are observations");
    },
  );
});

it.each([
  ["DYLD_FALLBACK_LIBRARY_PATH=", "undetermined"],
  ["DYLD_VERSIONED_LIBRARY_PATH=", "unresolved"],
  ["DYLD_IMAGE_SUFFIX=:", "unresolved"],
] as const)(
  "retains the missing-dependency semantics of %s through MCP",
  async (setting, status) => {
    const root = await createTestTempDirectory("rea-dyld-empty-mcp-");
    const path = join(root, "program");
    await writeFile(
      path,
      machoImage({
        commands: [
          buildVersionCommand(1),
          dyldEnvironmentCommand(setting),
          dylibCommand(LC.LOAD_DYLIB, "@loader_path/missing.dylib"),
        ],
      }),
    );
    await withClient(
      traceFixture(root, { directories: [], files: ["program"] }, path),
      async (client) => {
        const opened = await client.callTool({
          name: "open_binary",
          arguments: { path },
        });
        expect(
          opened.isError,
          JSON.stringify(opened.structuredContent),
        ).not.toBe(true);
        const result = await client.callTool({
          name: "trace_dylib_resolution",
          arguments: {},
        });
        expect(
          result.isError,
          JSON.stringify(result.structuredContent),
        ).not.toBe(true);
        const trace = dylibResolutionResultSchema.parse(
          structuredResult(result.structuredContent),
        );
        expect(trace.edges[0]?.resolution.status).toBe(status);
        expect(trace.coverage.status).toBe(
          status === "undetermined" ? "partial" : "complete",
        );
        expect(
          trace.images.find(({ path }) => path === "program")?.slices[0]
            ?.dyld_environment,
        ).toEqual([setting]);
        expect(
          trace.findings.some(
            ({ kind }) => kind === "required-load-unresolved",
          ),
        ).toBe(status === "unresolved");
      },
    );
  },
);

it("reports caller-selected roots that cannot be traced as invalid input", async () => {
  const app = join(
    await createTestTempDirectory("rea-dylib-roots-"),
    "Fixture.app",
  );
  await mkdir(join(app, "Contents/MacOS"), { recursive: true });
  await writeFile(
    join(app, "Contents/Info.plist"),
    "<plist><dict><key>CFBundleExecutable</key><string>App</string></dict></plist>",
  );
  await writeFile(
    join(app, "Contents/MacOS/App"),
    machoImage({ commands: [buildVersionCommand(1)] }),
  );
  await withClient(
    traceFixture(
      app,
      {
        directories: ["Contents", "Contents/MacOS"],
        files: ["Contents/Info.plist", "Contents/MacOS/App"],
      },
      app,
      [
        {
          name: "trace_dylib_resolution",
          arguments: {
            roots: ["Contents/MacOS/App", "Contents/MacOS/Missing"],
          },
        },
        {
          name: "trace_dylib_resolution",
          arguments: { roots: ["Contents/MacOS/App", "Contents/MacOS"] },
        },
        {
          name: "trace_dylib_resolution",
          arguments: { roots: ["Contents/MacOS/App", "Contents/Info.plist"] },
        },
      ],
    ),
    async (client) => {
      const opened = await client.callTool({
        name: "open_binary",
        arguments: { path: app },
      });
      expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
      for (const [root, message] of [
        ["Contents/MacOS/Missing", "is not a regular file"],
        ["Contents/MacOS", "is not a regular file"],
        ["Contents/Info.plist", "is not a Mach-O image"],
      ] as const) {
        const called = await client.callTool({
          name: "trace_dylib_resolution",
          arguments: { roots: ["Contents/MacOS/App", root] },
        });
        expect(called.isError, root).toBe(true);
        expect(parseMcpToolError(called), root).toMatchObject({
          error: {
            code: "invalid_request",
            details: {
              issues: [
                {
                  path: ["roots", 1],
                  reason: "invalid_value",
                  message: expect.stringContaining(`Root ${root} ${message}`),
                },
              ],
            },
          },
        });
      }
      // The added symlink is intentionally absent from the sealed regular-file inventory.
      const outside = await createTestTempDirectory("rea-dylib-mcp-outside-");
      await writeFile(join(outside, "Tool"), machoImage({}));
      await symlink(join(outside, "Tool"), join(app, "Contents/MacOS/outside"));
      const root = "Contents/MacOS/outside";
      const called = await client.callTool({
        name: "trace_dylib_resolution",
        arguments: { roots: ["Contents/MacOS/App", root] },
      });
      expect(called.isError).toBe(true);
      expect(parseMcpToolError(called)).toMatchObject({
        error: { code: "capability_unavailable" },
      });
      expect({
        error: await syntheticAppleError(
          join(app, "Contents/MacOS/App"),
          { roots: ["Contents/MacOS/App", root] },
          app,
        ),
      }).toMatchObject({
        error: {
          code: "invalid_request",
          details: {
            issues: [
              {
                path: ["roots", 1],
                reason: "invalid_value",
                message: expect.stringContaining(
                  `Root ${root} resolves outside the analyzed root`,
                ),
              },
            ],
          },
        },
      });
    },
  );
});
