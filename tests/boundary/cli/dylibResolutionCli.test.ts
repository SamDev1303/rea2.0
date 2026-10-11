import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { describe, expect } from "vitest";

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
import { parseEvidence } from "../../../src/domain/evidence.js";
import { AppleStaticArtifactProvider } from "../../../src/artifacts/AppleStaticArtifactProvider.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";
import type { TestProcesses } from "../../support/process/processFixture.js";
import { runOwnedDylibResolutionCli } from "../../support/investigation/ownedAppleStaticCliFixture.js";

const ENVIRONMENT = { REA_LOG_LEVEL: "silent", REA_ANALYSIS_PROVIDER: "auto" };

const writeFiles = async (
  root: string,
  files: Readonly<Record<string, string | Uint8Array>>,
): Promise<void> => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
};

/** A caller-selected root that cannot be traced is an input issue on that root. */
const expectRootInputError = async (
  processes: TestProcesses,
  {
    app,
    root,
    reason,
    message,
  }: {
    readonly app: string;
    readonly root: string;
    readonly reason: string;
    readonly message: string;
  },
): Promise<void> => {
  const rejected = await runOwnedDylibResolutionCli(processes, {
    ...appInventory(app),
    selectedRoots: [root],
  });
  expect(rejected.exitCode).toBe(1);
  expect(rejected.json).toMatchObject({
    error: "Analysis failed",
    code: "invalid_request",
    details: {
      issues: [
        {
          path: ["roots", 0],
          reason,
          message: expect.stringContaining(message),
        },
      ],
    },
  });
};

/** Static parser coverage for synthetic carriers that the controller must reject. */
const traceSyntheticDylib = async (
  path: string,
  parameters: Readonly<Record<string, JsonValue>>,
  app?: string,
) => {
  const bytes = await readFile(path);
  const client = new AppleStaticArtifactProvider().createClient({
    path,
    ...(app === undefined
      ? {}
      : { sourcePath: app, bundleInfoPlist: join(app, "Contents/Info.plist") }),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    kind: "executable",
    format: "mach-o",
    architecture: "arm64",
    availableArchitectures: ["arm64"],
  });
  try {
    const result = await client.execute("trace_dylib_resolution", parameters);
    if (result.ok) throw new Error("Expected the synthetic parser to reject");
    return projectAnalysisError(result.error);
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
};

const expectSyntheticSymlinkEscape = async (cli: TestCli, app: string) => {
  // A symlink carrier cannot enter a complete single-link inventory.
  const outside = await createTestTempDirectory("rea-dylib-outside-");
  await writeFiles(outside, { Tool: machoImage({}) });
  await symlink(outside, join(app, "Contents/Linked"));
  expect(
    await traceSyntheticDylib(
      join(app, "Contents/MacOS/App"),
      { roots: ["Contents/Linked/Tool"] },
      app,
    ),
  ).toMatchObject({
    code: "invalid_request",
    details: {
      issues: [
        {
          path: ["roots", 0],
          reason: "invalid_value",
          message: expect.stringContaining(
            "resolves outside the analyzed root",
          ),
        },
      ],
    },
  });
  const denied = await cli.run({
    arguments: [
      "trace-dylib-resolution",
      app,
      "--root",
      "Contents/Linked/Tool",
      "--json",
    ],
    environment: ENVIRONMENT,
  });
  expect(denied.exitCode).toBe(1);
  expect(denied.json).toMatchObject({ code: "capability_unavailable" });
};

const fixtureApp = async (): Promise<string> => {
  const app = join(
    await createTestTempDirectory("rea-dylib-cli-"),
    "Fixture.app",
  );
  await writeFiles(app, {
    "Contents/Info.plist":
      "<plist><dict><key>CFBundleExecutable</key><string>App</string></dict></plist>",
    "Contents/MacOS/App": machoImage({
      commands: [
        buildVersionCommand(1),
        rpathCommand("@executable_path/../Frameworks"),
        dylibCommand(LC.LOAD_DYLIB, "@rpath/libcore.dylib"),
        dylibCommand(LC.LOAD_WEAK_DYLIB, "@rpath/libgone.dylib"),
      ],
    }),
    "Contents/Frameworks/libcore.dylib": machoImage({
      fileType: FILE_TYPE.dylib,
      commands: [
        buildVersionCommand(1),
        dylibCommand(LC.ID_DYLIB, "@rpath/libcore.dylib"),
      ],
    }),
    "Contents/Helpers/tool": machoImage({
      commands: [
        buildVersionCommand(1),
        dylibCommand(LC.LOAD_DYLIB, "@loader_path/libnone.dylib"),
      ],
    }),
  });
  return app;
};

const appInventory = (
  app: string,
  additionalFiles: readonly string[] = [],
) => ({
  root: app,
  path: app,
  directories: [
    "Contents",
    "Contents/MacOS",
    "Contents/Frameworks",
    "Contents/Helpers",
  ],
  files: [
    "Contents/Info.plist",
    "Contents/MacOS/App",
    "Contents/Frameworks/libcore.dylib",
    "Contents/Helpers/tool",
    ...additionalFiles,
  ],
});

const withBrokenHelper = async (app: string): Promise<void> => {
  const broken = machoImage({ commands: [rpathCommand("x")] });
  // cmdsize 0 makes the command table unreadable.
  new DataView(broken.buffer).setUint32(32 + 4, 0, true);
  await writeFiles(app, { "Contents/Helpers/broken": broken });
};

describe("trace-dylib-resolution CLI", () => {
  cliTest(
    "traces every executable root of an app bundle",
    async ({ processes }) => {
      const app = await fixtureApp();
      const result = await runOwnedDylibResolutionCli(
        processes,
        appInventory(app),
      );
      expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
      const trace = dylibResolutionResultSchema.parse(
        (result.json as { normalized_result: unknown }).normalized_result,
      );
      expect(trace.root_path).toBe(app);
      expect(trace.roots.map(({ image }) => image)).toEqual([
        "Contents/Helpers/tool",
        "Contents/MacOS/App",
      ]);
      // The normalized result is the provider's only representation; Evidence
      // must not carry it a second time as raw_result.
      expect(result.json).toMatchObject({ raw_result: null });
      expect(
        trace.edges.map(({ loader, install_name: name, resolution }) => [
          loader,
          name,
          resolution.status,
          resolution.image,
        ]),
      ).toEqual([
        [
          "Contents/Helpers/tool",
          "@loader_path/libnone.dylib",
          "unresolved",
          null,
        ],
        [
          "Contents/MacOS/App",
          "@rpath/libcore.dylib",
          "resolved",
          "Contents/Frameworks/libcore.dylib",
        ],
        ["Contents/MacOS/App", "@rpath/libgone.dylib", "unresolved", null],
      ]);
      expect(trace.findings.map(({ kind }) => kind)).toEqual([
        "required-load-unresolved",
        "weak-load-unresolved",
      ]);
      expect(
        trace.images.every(({ sha256 }) => /^[0-9a-f]{64}$/u.test(sha256)),
      ).toBe(true);
    },
  );

  cliTest(
    "narrows roots and architecture, and rejects escaping roots",
    async ({ cli, processes }) => {
      const app = await fixtureApp();
      const narrowed = await runOwnedDylibResolutionCli(processes, {
        ...appInventory(app),
        selectedRoots: ["Contents/MacOS/App"],
        architecture: "arm64",
      });
      expect(narrowed.exitCode).toBe(0);
      expect(
        (narrowed.json as { normalized_result: { roots: unknown } })
          .normalized_result.roots,
      ).toEqual([{ image: "Contents/MacOS/App", architecture: "arm64" }]);
      for (const [root, reason, message] of [
        ["../outside", "invalid_format", "Use a normalized path"],
        ["Contents/Info.plist", "invalid_value", "is not a Mach-O image"],
      ] as const) {
        await expectRootInputError(processes, { app, root, reason, message });
      }
      await expectSyntheticSymlinkEscape(cli, app);
    },
  );

  cliTest(
    "resolves a standalone Mach-O against its own directory",
    async ({ processes }) => {
      const directory = await createTestTempDirectory("rea-dylib-standalone-");
      await writeFiles(directory, {
        tool: machoImage({
          commands: [
            buildVersionCommand(1),
            dylibCommand(LC.LOAD_DYLIB, "@loader_path/lib/libhelper.dylib"),
            dylibCommand(LC.LOAD_DYLIB, "@loader_path/../escape.dylib"),
          ],
        }),
        "lib/libhelper.dylib": machoImage({
          fileType: FILE_TYPE.dylib,
          commands: [buildVersionCommand(1)],
        }),
        "unrelated.txt": "not traversed",
      });
      const result = await runOwnedDylibResolutionCli(processes, {
        root: directory,
        path: join(directory, "tool"),
        directories: ["lib"],
        files: ["tool", "lib/libhelper.dylib", "unrelated.txt"],
      });
      expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
      const trace = dylibResolutionResultSchema.parse(
        (result.json as { normalized_result: unknown }).normalized_result,
      );
      expect(trace.roots).toEqual([{ image: "tool", architecture: "arm64" }]);
      expect(trace.edges.map(({ resolution }) => resolution)).toEqual([
        { status: "resolved", image: "lib/libhelper.dylib" },
        { status: "undetermined", image: null },
      ]);
    },
  );

  cliTest(
    "reports unparsed Mach-O files found while enumerating roots",
    async ({ processes }) => {
      const app = await fixtureApp();
      await withBrokenHelper(app);
      const result = await runOwnedDylibResolutionCli(
        processes,
        appInventory(app, ["Contents/Helpers/broken"]),
      );
      expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
      const trace = dylibResolutionResultSchema.parse(
        (result.json as { normalized_result: unknown }).normalized_result,
      );
      expect(trace.coverage).toMatchObject({
        status: "partial",
        unparsed_images: ["Contents/Helpers/broken"],
      });
    },
  );
});

cliTest(
  "retains directory requirements when resolving dylib install names",
  async ({ processes }) => {
    const directory = await createTestTempDirectory("rea-dylib-path-cli-");
    const names = [
      "@loader_path/lib/libhelper.dylib/",
      "@loader_path/lib/libhelper.dylib/.",
      "@rpath/libhelper.dylib/",
      "@rpath/libhelper.dylib/.",
      "@rpath/",
      "@loader_path/lib/./libhelper.dylib",
      "@loader_path/lib//libhelper.dylib",
    ];
    await writeFiles(directory, {
      tool: machoImage({
        commands: [
          buildVersionCommand(1),
          rpathCommand("@loader_path/lib/libhelper.dylib"),
          rpathCommand("@loader_path/lib"),
          ...names.map((name) => dylibCommand(LC.LOAD_DYLIB, name)),
        ],
      }),
      "lib/libhelper.dylib": machoImage({
        fileType: FILE_TYPE.dylib,
        commands: [buildVersionCommand(1)],
      }),
    });
    const result = await runOwnedDylibResolutionCli(processes, {
      root: directory,
      path: join(directory, "tool"),
      directories: ["lib"],
      files: ["tool", "lib/libhelper.dylib"],
    });
    expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
    const trace = dylibResolutionResultSchema.parse(
      parseEvidence(result.json).normalized_result,
    );
    expect(
      trace.edges.map(({ install_name, candidates, resolution }) => ({
        install_name,
        outcome: candidates[0]?.outcome,
        resolution,
      })),
    ).toEqual(
      names.map((name, index) => ({
        install_name: name,
        outcome: index < 5 ? "absent" : "resolved",
        resolution:
          index < 5
            ? { status: "unresolved", image: null }
            : { status: "resolved", image: "lib/libhelper.dylib" },
      })),
    );
    expect(
      trace.findings.map(({ kind, edge_index }) => [kind, edge_index]),
    ).toEqual(
      [0, 1, 2, 3, 4].map((index) => ["required-load-unresolved", index]),
    );
  },
);

describe.skipIf(process.getuid?.() === 0)(
  "trace-dylib-resolution permissions",
  () => {
    cliTest(
      "reports an unreadable dependency as a permission failure",
      async ({ cli }) => {
        const directory = await createTestTempDirectory("rea-dylib-denied-");
        await writeFiles(directory, {
          tool: machoImage({
            commands: [
              dylibCommand(LC.LOAD_DYLIB, "@loader_path/libsecret.dylib"),
            ],
          }),
          "libsecret.dylib": machoImage({ fileType: FILE_TYPE.dylib }),
        });
        await chmod(join(directory, "libsecret.dylib"), 0o000);
        try {
          const result = await cli.run({
            arguments: [
              "trace-dylib-resolution",
              join(directory, "tool"),
              "--json",
            ],
            environment: ENVIRONMENT,
          });
          expect(result.exitCode).toBe(1);
          expect(result.json).toMatchObject({ code: "capability_unavailable" });
          expect(
            await traceSyntheticDylib(join(directory, "tool"), {}),
          ).toMatchObject({
            details: {
              reason: "unavailable",
              detail: expect.stringContaining(
                "Permission denied (EACCES) reading libsecret.dylib",
              ),
            },
          });
        } finally {
          await chmod(join(directory, "libsecret.dylib"), 0o644);
        }
      },
    );
  },
);

cliTest(
  "reports embedded path overrides as conditional without changing diagnostic-only resolution",
  async ({ processes }) => {
    for (const [setting, expected] of [
      ["DYLD_LIBRARY_PATH=/external", "conditional"],
      ["DYLD_PRINT_LIBRARIES=1", "resolved"],
      ["DYLD_FALLBACK_LIBRARY_PATH=/external", "resolved"],
      ["DYLD_FRAMEWORK_PATH=/external", "resolved"],
      ["DYLD_ROOT_PATH=/external", "resolved"],
      ["DYLD_OVERLAY_PATH=/external", "resolved"],
    ] as const) {
      const app = await fixtureApp();
      await writeFiles(app, {
        "Contents/MacOS/App": machoImage({
          commands: [
            dyldEnvironmentCommand(setting),
            buildVersionCommand(1),
            rpathCommand("@executable_path/../Absent"),
            rpathCommand("@executable_path/../Frameworks"),
            dylibCommand(LC.LOAD_DYLIB, "@rpath/libcore.dylib"),
          ],
        }),
      });
      const result = await runOwnedDylibResolutionCli(processes, {
        ...appInventory(app),
        selectedRoots: ["Contents/MacOS/App"],
      });
      expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
      const trace = dylibResolutionResultSchema.parse(
        parseEvidence(result.json).normalized_result,
      );
      expect(trace.edges[0]?.resolution.status).toBe(expected);
      expect(trace.coverage.status).toBe(
        expected === "conditional" ? "partial" : "complete",
      );
      expect(
        trace.images.find(({ path }) => path === "Contents/MacOS/App")
          ?.slices[0]?.dyld_environment,
      ).toEqual([setting]);
      if (expected === "conditional")
        expect(trace.findings[0]?.explanation).toContain(
          "does not establish which image dyld will load",
        );
    }
  },
);

cliTest(
  "retains definitive load findings for an explicitly selected app library root",
  async ({ processes }) => {
    const app = await fixtureApp();
    const settings = [
      "DYLD_LIBRARY_PATH=/external",
      "DYLD_INSERT_LIBRARIES=/external/injected.dylib",
    ];
    await writeFiles(app, {
      "Contents/Frameworks/libcore.dylib": machoImage({
        fileType: FILE_TYPE.dylib,
        commands: [
          buildVersionCommand(1),
          ...settings.map(dyldEnvironmentCommand),
          dylibCommand(LC.LOAD_DYLIB, "@loader_path/child.dylib"),
          dylibCommand(LC.LOAD_DYLIB, "@loader_path/missing.dylib"),
        ],
      }),
      "Contents/Frameworks/child.dylib": machoImage({
        fileType: FILE_TYPE.dylib,
        commands: [buildVersionCommand(1)],
      }),
    });
    const result = await runOwnedDylibResolutionCli(processes, {
      ...appInventory(app, ["Contents/Frameworks/child.dylib"]),
      selectedRoots: ["Contents/Frameworks/libcore.dylib"],
    });
    expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
    const trace = dylibResolutionResultSchema.parse(
      parseEvidence(result.json).normalized_result,
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
      trace.images.find(
        ({ path }) => path === "Contents/Frameworks/libcore.dylib",
      )?.slices[0]?.dyld_environment,
    ).toEqual(settings);
    expect(
      trace.findings.find(({ kind }) => kind === "dyld-environment-present")
        ?.explanation,
    ).toContain("entries in this non-executable root are observations");
  },
);

cliTest(
  "distinguishes empty search directories from empty versioned or suffix lists",
  async ({ processes }) => {
    for (const [setting, status] of [
      ["DYLD_FALLBACK_LIBRARY_PATH=", "undetermined"],
      ["DYLD_VERSIONED_LIBRARY_PATH=", "unresolved"],
      ["DYLD_IMAGE_SUFFIX=:", "unresolved"],
    ] as const) {
      const root = await createTestTempDirectory("rea-dyld-empty-cli-");
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
      const result = await runOwnedDylibResolutionCli(processes, {
        root,
        path,
        directories: [],
        files: ["program"],
      });
      expect(result.exitCode, JSON.stringify(result.json)).toBe(0);
      const trace = dylibResolutionResultSchema.parse(
        parseEvidence(result.json).normalized_result,
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
        trace.findings.some(({ kind }) => kind === "required-load-unresolved"),
      ).toBe(status === "unresolved");
    }
  },
);
