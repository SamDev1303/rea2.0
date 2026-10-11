import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "plist";
import { expect, it, vi } from "vitest";

import {
  sealOwnedStaticFixtureInventory,
  withBoundedOwnedStaticFixtureInventory,
  type OwnedStaticFixtureInventoryToken,
} from "../../../../src/application/investigationSafety/OwnedStaticFixtureInventory.js";
import { AppleStaticArtifactProvider } from "../../../../src/artifacts/AppleStaticArtifactProvider.js";
import { DirectoryArtifactReader } from "../../../../src/artifacts/DirectoryArtifactReader.js";
import { machoImage } from "../../../../src/artifacts/apple/MachoImage.fixture.js";
import {
  createOwnedAppleStaticSession,
  isOwnedAppleStaticSession,
} from "../../../../src/application/binary/OwnedAppleStaticSession.js";
import { createServer } from "../../../../src/server/createServer.js";
import {
  attachOwnedFixturePolicy,
  digestOwnedFixtureInput,
  sealOwnedFixturePolicy,
} from "../../../../src/application/investigationSafety/OwnedFixturePolicy.js";
import { toolContract } from "../../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import * as regularFiles from "../../../../src/filesystem/RegularFile.js";
import type { DirectAnalysisSession } from "../../../../src/application/DirectAnalysisDependencies.js";

const operations = [
  "decode_interface_builder",
  "inspect_keyed_archive",
  "trace_dylib_resolution",
] as const;

/** Source-authored unit controller stage, fixed before invoking target handlers. */
const withReaderScope = <T>(
  selected: {
    readonly inventory: OwnedStaticFixtureInventoryToken;
    readonly session: DirectAnalysisSession;
    readonly operation: (typeof operations)[number];
    readonly primaryPath: string;
  },
  run: () => T,
): T => {
  const { inventory, session, operation, primaryPath } = selected;
  const inputDigest = digestOwnedFixtureInput({
    args: { path: primaryPath },
    options: {},
  });
  return withBoundedOwnedStaticFixtureInventory(inventory, session, operation, {
    run,
    input_digest: inputDigest,
    open_binding: {
      kind: "cli-stage",
      primary_path: primaryPath,
      input_digest: inputDigest,
    },
  });
};

const fixture = async () => {
  const root = await createTestTempDirectory("rea-owned-apple-controller-");
  const app = join(root, "Fixture.app");
  const directories = [
    app,
    join(app, "Contents"),
    join(app, "Contents/MacOS"),
    join(app, "Contents/Resources"),
  ];
  for (const directory of directories) await mkdir(directory);
  const archive = join(root, "Owned.plist");
  const archiveBytes = Buffer.from(
    build({
      $archiver: "NSKeyedArchiver",
      $version: 100000,
      $objects: ["$null", "owned archive value"],
      $top: { root: { CF$UID: 1 } },
    }),
  );
  const content = [
    [
      join(app, "Contents/Info.plist"),
      Buffer.from(
        "<plist><dict><key>CFBundleExecutable</key><string>App</string></dict></plist>",
      ),
    ],
    [join(app, "Contents/MacOS/App"), Buffer.from(machoImage({}))],
    [join(app, "Contents/Resources/Owned.nib"), archiveBytes],
    [archive, archiveBytes],
  ] as const;
  for (const [path, bytes] of content) await writeFile(path, bytes);
  const inventoryData = {
    roots: [root],
    directories,
    files: content.map(([path, bytes]) => ({
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };
  const inventory = await sealOwnedStaticFixtureInventory(inventoryData);
  return {
    root,
    app,
    archive,
    inventory,
    inventoryData,
    session: createOwnedAppleStaticSession(),
  };
};

it("brands only immutable constructor-owned sessions and denies unscoped reads", async () => {
  const session = createOwnedAppleStaticSession();
  expect(Object.isFrozen(session)).toBe(true);
  expect(isOwnedAppleStaticSession(session)).toBe(true);
  expect(isOwnedAppleStaticSession({ ...session })).toBe(false);
  expect(isOwnedAppleStaticSession(Object.create(session))).toBe(false);
  expect(session.status()).toMatchObject({
    open: false,
    analysis_provider_binding: null,
    analysis_provider_candidates: [],
    capabilities: operations.map((operation) =>
      expect.objectContaining({ operation, available: true }),
    ),
  });
  expect(await session.open("/nonexistent-unowned-fixture")).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCapabilityUnavailableError" },
  });
  expect(await session.execute("inspect_keyed_archive", {})).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisCapabilityUnavailableError" },
  });
  await session.close();
});

it.each(operations)(
  "runs real %s parsing through exact predeclared MCP grants",
  async (operation) => {
    const { app, archive, inventoryData, session } = await fixture();
    const server = createServer(
      { kind: "session", session },
      { environment: {} },
    );
    const requests = [
      {
        name: "open_binary",
        arguments: {
          path: operation === "inspect_keyed_archive" ? archive : app,
        },
      },
      { name: operation, arguments: {} },
    ] as const;
    const portId = "controller-owned-apple-static-port";
    const capability = "owned-apple-static-fixture";
    const token = await sealOwnedFixturePolicy(
      {
        roots: inventoryData.roots,
        files: inventoryData.files.map((file) => ({
          ...file,
          role: "dependency" as const,
        })),
        static_inventory: { directories: inventoryData.directories },
        environment: [],
        endpoints: [],
        available_capabilities: [capability],
        grants: requests.map((request) => ({
          operation: request.name,
          input_digest: digestOwnedFixtureInput(
            toolContract(request.name).inputSchema.parse(request.arguments),
          ),
          capability,
          mode: "owned-static" as const,
          port_id: portId,
        })),
      },
      { owned_static_ports: [{ port_id: portId, reference: session }] },
    );
    attachOwnedFixturePolicy(server, token, session);
    const client = new Client({ name: "owned-apple-exact-mcp", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      for (const request of requests) {
        const result = await client.callTool(request);
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        if (request.name === operation) {
          const evidence = parseEvidence(
            toolContract(operation).outputSchema.parse(
              result.structuredContent,
            ),
          );
          expect(evidence.operation).toBe(operation);
          expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
          if (operation === "inspect_keyed_archive")
            expect(evidence.normalized_result).toMatchObject({
              roots: { root: { CF$UID: 1 } },
              objects: expect.arrayContaining([
                expect.objectContaining({ value: "owned archive value" }),
              ]),
            });
          else if (operation === "decode_interface_builder")
            expect(evidence.normalized_result).toMatchObject({
              documents: [{ relative_path: "Contents/Resources/Owned.nib" }],
            });
          else
            expect(evidence.normalized_result).toMatchObject({
              roots: [{ image: "Contents/MacOS/App", architecture: "arm64" }],
            });
        }
      }
      expect(
        (
          await client.callTool({
            name: operation,
            arguments:
              operation === "inspect_keyed_archive"
                ? { path: "other.plist" }
                : operation === "decode_interface_builder"
                  ? { max_documents: 1 }
                  : { roots: ["Contents/MacOS/App"] },
          })
        ).isError,
      ).toBe(true);
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  },
);

it.each(operations)(
  "preserves real %s parsing through the static-only session",
  async (operation) => {
    const { app, archive, inventory, session } = await fixture();
    await withReaderScope(
      {
        inventory,
        session,
        operation,
        primaryPath: operation === "inspect_keyed_archive" ? archive : app,
      },
      async () => {
        const opened = await session.open(
          operation === "inspect_keyed_archive" ? archive : app,
        );
        if (!opened.ok) throw opened.error;
        const result = await session.execute(operation, {});
        if (!result.ok) throw result.error;
        const direct = new AppleStaticArtifactProvider().createClient(
          opened.value,
        );
        try {
          const directResult = await direct.execute(operation, {});
          if (!directResult.ok) throw directResult.error;
          expect(result.value).toEqual({
            ...directResult.value,
            subject: {
              path: opened.value.path,
              format: opened.value.format,
              ...(opened.value.architecture === undefined
                ? {}
                : { architecture: opened.value.architecture }),
              sha256: opened.value.sha256,
            },
          });
        } finally {
          await direct.close();
        }
        expect(session.status()).toMatchObject({
          open: true,
          analysis_provider_binding: null,
          analysis_provider_candidates: [],
        });
      },
    );
    await session.close();
  },
);

it("binds the active scope to its exact owner and reader operation", async () => {
  const { app, inventory, session } = await fixture();
  const other = createOwnedAppleStaticSession();
  await withReaderScope(
    {
      inventory,
      session,
      operation: "inspect_keyed_archive",
      primaryPath: app,
    },
    async () => {
      expect(await other.open(app)).toMatchObject({ ok: false });
      expect(
        await session.execute("decode_interface_builder", {}),
      ).toMatchObject({ ok: false });
      expect(await session.open(app, { providerId: "ghidra" })).toMatchObject({
        ok: false,
      });
      expect(await session.execute("inspect_macho", {})).toMatchObject({
        ok: false,
      });
      expect(
        await session.closeWithSnapshot(join(app, "unexpected.json"), false),
      ).toMatchObject({ ok: false });
      expect(session.exportAnalysisSnapshot()).toMatchObject({ ok: false });
    },
  );
  await session.close();
  await other.close();
});

it("never runs an open_binary admitted callback inside an artifact grant", async () => {
  const { archive, inventory, session } = await fixture();
  await withReaderScope(
    {
      inventory,
      session,
      operation: "inspect_keyed_archive",
      primaryPath: archive,
    },
    async () => {
      const opened = await session.open(archive);
      if (!opened.ok) throw opened.error;
      const callback = vi.fn(async () => "UNAPPROVED_OPEN_CALLBACK");
      expect(
        await session.withAdmittedAnalysis("open_binary", undefined, callback),
      ).toMatchObject({ ok: false });
      expect(callback).not.toHaveBeenCalled();
    },
  );
  await session.close();
});

it("limits admitted callbacks to readers even inside an exact direct-open scope", async () => {
  const { archive, inventory, session } = await fixture();
  const inputDigest = digestOwnedFixtureInput({ path: archive });
  await withBoundedOwnedStaticFixtureInventory(
    inventory,
    session,
    "open_binary",
    {
      input_digest: inputDigest,
      open_binding: {
        kind: "direct-open",
        primary_path: archive,
        input_digest: inputDigest,
      },
      run: async () => {
        const opened = await session.open(archive);
        if (!opened.ok) throw opened.error;
        const callback = vi.fn(async () => "UNAPPROVED_DIRECT_CALLBACK");
        for (const operation of ["open_binary", "inspect_macho", "health"])
          expect(
            await session.withAdmittedAnalysis(operation, undefined, callback),
          ).toMatchObject({ ok: false });
        expect(callback).not.toHaveBeenCalled();
      },
    },
  );
  await session.close();
});

it("cannot use one artifact grant to reopen another inventoried target", async () => {
  const { app, archive, inventory, session } = await fixture();
  await withReaderScope(
    {
      inventory,
      session,
      operation: "inspect_keyed_archive",
      primaryPath: archive,
    },
    async () => {
      const opened = await session.open(archive);
      if (!opened.ok) throw opened.error;
      const acquisition = vi.spyOn(regularFiles, "openRegularFile");
      try {
        expect(await session.open(app)).toMatchObject({ ok: false });
        expect(acquisition).not.toHaveBeenCalled();
        expect(session.activeTarget()?.path).toBe(archive);
      } finally {
        acquisition.mockRestore();
      }
    },
  );
  await session.close();
});

it("finishes an admitted reader before a concurrent close drains it", async () => {
  const { archive, inventory, session } = await fixture();
  await withReaderScope(
    {
      inventory,
      session,
      operation: "inspect_keyed_archive",
      primaryPath: archive,
    },
    async () => {
      const opened = await session.open(archive);
      if (!opened.ok) throw opened.error;
      let enter = () => {};
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      const admitted = session.withAdmittedAnalysis(
        "inspect_keyed_archive",
        undefined,
        async (analysis) => {
          enter();
          await released;
          expect(
            await analysis.execute("decode_interface_builder", {}),
          ).toMatchObject({ ok: false });
          return analysis.execute(
            "inspect_keyed_archive",
            {},
            {
              signal: AbortSignal.timeout(2000),
            },
          );
        },
      );
      await entered;
      const closed = session.close();
      release();
      const [result, cleanup] = await Promise.all([admitted, closed]);
      if (!result.ok) throw result.error;
      expect(result.value).toMatchObject({
        ok: true,
        value: {
          result: {
            roots: { root: { CF$UID: 1 } },
            objects: expect.arrayContaining([
              expect.objectContaining({ value: "owned archive value" }),
            ]),
          },
        },
      });
      expect(cleanup).toMatchObject({ ok: true });
      expect(session.status()).toMatchObject({ open: false });
    },
  );
});

it.each(["descendant", "symlink", "protected", "hardlink"] as const)(
  "refuses a new %s before the archive reader acquires bytes",
  async (change) => {
    const { root, archive, inventory, session } = await fixture();
    await withReaderScope(
      {
        inventory,
        session,
        operation: "inspect_keyed_archive",
        primaryPath: archive,
      },
      async () => {
        const opened = await session.open(archive);
        if (!opened.ok) throw opened.error;
        const added = join(
          root,
          change === "protected" ? ".env" : "unexpected",
        );
        if (change === "symlink") await symlink(archive, added);
        else if (change === "hardlink") await link(archive, added);
        else await writeFile(added, "SYNTHETIC_UNAPPROVED_CONTENT");
        const acquisition = vi.spyOn(DirectoryArtifactReader.prototype, "open");
        try {
          expect(
            await session.execute("inspect_keyed_archive", {}),
          ).toMatchObject({ ok: false });
          expect(acquisition).not.toHaveBeenCalled();
        } finally {
          acquisition.mockRestore();
        }
      },
    );
    await session.close();
  },
);

it("keeps the public MCP entry denied even with a constructor-owned session", async () => {
  const { app, session } = await fixture();
  const server = createServer(
    { kind: "session", session },
    { environment: {} },
  );
  const client = new Client({
    name: "owned-apple-public-denial",
    version: "1",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({
      name: "open_binary",
      arguments: { path: app },
    });
    expect(result.isError).toBe(true);
    expect(session.activeTarget()).toBeUndefined();
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
});
