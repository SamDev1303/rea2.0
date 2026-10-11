import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createOwnedAppleStaticSession } from "../../../src/application/binary/OwnedAppleStaticSession.js";
import * as snapshots from "../../../src/application/binary/AnalysisSnapshotFiles.js";
import * as targets from "../../../src/application/BinaryTargetResolver.js";
import {
  attachOwnedFixturePolicy,
  digestOwnedFixtureInput,
  sealOwnedFixturePolicy,
} from "../../../src/application/investigationSafety/OwnedFixturePolicy.js";
import { staticOpenAuthority } from "../../../src/application/investigationSafety/OwnedStaticFixtureAuthority.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

vi.mock(
  "../../../src/application/binary/AnalysisSnapshotFiles.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../src/application/binary/AnalysisSnapshotFiles.js")
      >();
    return {
      ...actual,
      readAnalysisSnapshot: vi.fn(actual.readAnalysisSnapshot),
    };
  },
);
vi.mock(
  "../../../src/application/BinaryTargetResolver.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../../../src/application/BinaryTargetResolver.js")
      >();
    return { ...actual, parseBinaryTarget: vi.fn(actual.parseBinaryTarget) };
  },
);

it.each([
  { snapshot_path: "outside" },
  { snapshot_path: "primary" },
  { provider_id: "auto" },
  { format: "dos-com" },
])(
  "rejects an exactly granted auxiliary open input before snapshot acquisition: %j",
  async (auxiliary) => {
    const root = await createTestTempDirectory("rea-static-auxiliary-");
    const path = join(root, "fixture");
    await fs.writeFile(path, "owned");
    const session = createOwnedAppleStaticSession();
    const server = createServer(
      { kind: "session", session },
      { environment: {} },
    );
    const selected =
      "snapshot_path" in auxiliary
        ? {
            snapshot_path:
              auxiliary.snapshot_path === "primary"
                ? path
                : join(root, "secrets", "snapshot.json"),
          }
        : auxiliary;
    const input = toolContract("open_binary").inputSchema.parse({
      path,
      ...selected,
    });
    const token = await sealOwnedFixturePolicy(
      {
        roots: [root],
        files: [
          {
            path,
            role: "dependency",
            sha256: createHash("sha256").update("owned").digest("hex"),
          },
        ],
        static_inventory: { directories: [] },
        environment: [],
        endpoints: [],
        available_capabilities: ["static"],
        grants: [
          {
            operation: "open_binary",
            input_digest: digestOwnedFixtureInput(input),
            capability: "static",
            mode: "owned-static",
            port_id: "static",
          },
        ],
      },
      { owned_static_ports: [{ port_id: "static", reference: session }] },
    );
    attachOwnedFixturePolicy(server, token, session);
    const client = new Client({ name: "static-auxiliary-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    vi.mocked(targets.parseBinaryTarget).mockClear();
    vi.mocked(snapshots.readAnalysisSnapshot).mockClear();
    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const response = await client.callTool({
        name: "open_binary",
        arguments: input,
      });
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).toContain("capability_unavailable");
      expect(snapshots.readAnalysisSnapshot).not.toHaveBeenCalled();
      expect(targets.parseBinaryTarget).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
      await session.close();
    }
  },
);

it.each(["snapshot", "provider", "target-format"])(
  "rejects CLI staging option %s before any target processing",
  (key) => {
    expect(() =>
      staticOpenAuthority(
        "inspect_keyed_archive",
        {
          args: { path: "/synthetic/fixture", archive: "." },
          options: { [key]: "/synthetic/auxiliary" },
        },
        "0".repeat(64),
      ),
    ).toThrow();
  },
);
