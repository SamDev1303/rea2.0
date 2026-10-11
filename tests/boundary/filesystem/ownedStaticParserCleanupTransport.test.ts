import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import fs, { open } from "node:fs/promises";
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
import { machoImage } from "../../../src/artifacts/apple/MachoImage.fixture.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
it.each(["open_binary", "trace_dylib_resolution"] as const)(
  "%s parser owners survive MCP projection and lifecycle retries",
  async (operation) => {
    const root = await createTestTempDirectory("rea-mcp-parser-cleanup-");
    const path = join(root, "Image");
    const bytes = Buffer.from(machoImage({}));
    await fs.writeFile(path, bytes);
    const session = createOwnedAppleStaticSession();
    const server = createServer(
      { kind: "session", session },
      { environment: {} },
    );
    const requests = [
      { name: "open_binary" as const, arguments: { path } },
      { name: "trace_dylib_resolution" as const, arguments: {} },
    ];
    const token = await sealOwnedFixturePolicy(
      {
        roots: [root],
        files: [
          {
            path,
            role: "dependency",
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ],
        static_inventory: { directories: [] },
        environment: [],
        endpoints: [],
        available_capabilities: ["static"],
        grants: requests.map((request) => ({
          operation: request.name,
          input_digest: digestOwnedFixtureInput(
            toolContract(request.name).inputSchema.parse(request.arguments),
          ),
          capability: "static",
          mode: "owned-static" as const,
          port_id: "static",
        })),
      },
      { owned_static_ports: [{ port_id: "static", reference: session }] },
    );
    attachOwnedFixturePolicy(server, token, session);
    const client = new Client({ name: "parser-close-test", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    let emergencyClose: (() => Promise<void>) | undefined;
    let closes = 0;
    try {
      if (operation === "trace_dylib_resolution")
        expect((await client.callTool(requests[0]!)).isError).not.toBe(true);
      vi.mocked(open).mockImplementation(async (selected, flags, mode) => {
        const handle = await fs.open(selected, flags, mode);
        if (selected === path) {
          const close = handle.close.bind(handle);
          emergencyClose = async () => {
            if (handle.fd >= 0) await close();
          };
          vi.spyOn(handle, "read").mockRejectedValue(
            new Error("synthetic primary parser failure"),
          );
          vi.spyOn(handle, "close").mockImplementation(async () => {
            if (++closes === 1)
              throw new Error("synthetic close parser failure");
            await close();
          });
        }
        return handle;
      });
      const response = await client.callTool(
        operation === "open_binary" ? requests[0]! : requests[1]!,
      );
      expect(response.isError).toBe(true);
      expect(JSON.stringify(response)).toContain("cleanup_incomplete");
      expect(JSON.stringify(response)).not.toMatch(
        /retainedOwnedFile|synthetic primary|synthetic close/u,
      );
      expect(ownedFixturePendingCleanupCount(server)).toBe(1);
      vi.mocked(open).mockClear();
      expect(
        (
          await client.callTool(
            operation === "open_binary" ? requests[0]! : requests[1]!,
          )
        ).isError,
      ).toBe(true);
      expect(open).not.toHaveBeenCalled();
      const retry = retryOwnedFixtureCleanup(server);
      expect(retryOwnedFixtureCleanup(server)).toBe(retry);
      await Promise.all([retry, server.close()]);
      expect(closes).toBe(2);
      expect(ownedFixturePendingCleanupCount(server)).toBe(0);
      expect(response.isError).toBe(true);
    } finally {
      vi.restoreAllMocks();
      await emergencyClose?.();
      await client.close();
      await server.close();
      await session.close();
    }
  },
);
