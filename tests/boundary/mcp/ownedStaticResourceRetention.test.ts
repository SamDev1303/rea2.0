import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createOwnedAppleStaticSession } from "../../../src/application/binary/OwnedAppleStaticSession.js";
import {
  attachOwnedFixturePolicy,
  digestOwnedFixtureInput,
  ownedFixturePendingCleanupCount,
  retryOwnedFixtureCleanup,
  sealOwnedFixturePolicy,
} from "../../../src/application/investigationSafety/OwnedFixturePolicy.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it("retains a cleanup owner after actual MCP serialization and retries it once through overlapping lifecycle paths", async () => {
  const root = await createTestTempDirectory("rea-mcp-cleanup-owner-");
  const path = join(root, "fixture");
  await fs.writeFile(path, "owned");
  const session = createOwnedAppleStaticSession();
  const server = createServer(
    { kind: "session", session },
    { environment: {} },
  );
  const input = toolContract("open_binary").inputSchema.parse({ path });
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
  const client = new Client({ name: "cleanup-owner-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const originalOpen = fs.open;
  let attempts = 0;
  let emergencyClose: (() => Promise<void>) | undefined;
  const open = vi
    .spyOn(fs, "open")
    .mockImplementation(async (selected, flags, mode) => {
      const handle = await originalOpen(selected, flags, mode);
      if (selected === path) {
        const close = handle.close.bind(handle);
        emergencyClose = async () => {
          if (handle.fd >= 0) await close();
        };
        vi.spyOn(handle, "close").mockImplementation(async () => {
          if (++attempts === 1)
            throw new Error("synthetic recoverable inventory close");
          await close();
        });
      }
      return handle;
    });
  try {
    const response = await client.callTool({
      name: "open_binary",
      arguments: { path },
    });
    expect(response.isError).toBe(true);
    expect(JSON.stringify(response)).toContain("cleanup_incomplete");
    expect(ownedFixturePendingCleanupCount(server)).toBe(1);
    expect(JSON.stringify(response)).not.toMatch(
      /retainedOwnedFile|synthetic recoverable/u,
    );
    expect(session.activeTarget()).toBeUndefined();
    open.mockClear();
    const repeated = await client.callTool({
      name: "open_binary",
      arguments: { path },
    });
    expect(repeated.isError).toBe(true);
    expect(open).not.toHaveBeenCalled();
    const explicit = retryOwnedFixtureCleanup(server);
    const same = retryOwnedFixtureCleanup(server);
    expect(explicit).toBe(same);
    await Promise.all([explicit, same, server.close()]);
    expect(attempts).toBe(2);
    expect(ownedFixturePendingCleanupCount(server)).toBe(0);
    expect(response.isError).toBe(true);
  } finally {
    vi.restoreAllMocks();
    await emergencyClose?.();
    await client.close();
    await server.close();
    await session.close();
  }
});
