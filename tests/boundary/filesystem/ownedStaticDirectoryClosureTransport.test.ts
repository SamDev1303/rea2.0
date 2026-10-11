import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import fs, { opendir } from "node:fs/promises";
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
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, opendir: vi.fn(actual.opendir) };
});
it.each([false, true])(
  "retains a dyld directory reader through MCP and concurrent shutdown (primary=%s)",
  async (failTraversal) => {
    const root = await createTestTempDirectory("rea-dyld-directory-transport-");
    const bundle = join(root, "Fixture.app");
    const contents = join(bundle, "Contents");
    const executables = join(contents, "MacOS");
    await fs.mkdir(executables, { recursive: true });
    const plist = join(contents, "Info.plist");
    const path = join(executables, "Image");
    const image = Buffer.from(machoImage({}));
    const metadata = Buffer.from(
      '<?xml version="1.0"?><plist><dict><key>CFBundleExecutable</key><string>Image</string></dict></plist>',
    );
    await fs.writeFile(plist, metadata);
    await fs.writeFile(path, image);
    const session = createOwnedAppleStaticSession();
    const server = createServer(
      { kind: "session", session },
      { environment: {} },
    );
    const requests = [
      { name: "open_binary" as const, arguments: { path: bundle } },
      { name: "trace_dylib_resolution" as const, arguments: {} },
    ];
    const token = await sealOwnedFixturePolicy(
      {
        roots: [bundle],
        files: [
          { path, bytes: image },
          { path: plist, bytes: metadata },
        ].map(({ path: selected, bytes }) => ({
          path: selected,
          role: "dependency" as const,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        })),
        static_inventory: { directories: [contents, executables] },
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
    const client = new Client({
      name: "dyld-directory-lifecycle",
      version: "1",
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const emergency: (() => Promise<void>)[] = [];
    let nativeCloses = 0;
    try {
      await server.connect(st);
      await client.connect(ct);
      expect((await client.callTool(requests[0]!)).isError).not.toBe(true);
      vi.mocked(opendir).mockImplementation(async (selected, options) => {
        const handle = await fs.opendir(selected, options);
        emergency.push(handle.close.bind(handle));
        vi.spyOn(handle, "close").mockImplementation(async () => {
          nativeCloses += 1;
          throw new Error("synthetic directory close");
        });
        if (failTraversal)
          vi.spyOn(handle, "read").mockRejectedValue(
            new Error("synthetic directory traversal"),
          );
        return handle;
      });
      const response = await client.callTool(requests[1]!);
      expect(response.isError).toBe(true);
      expect(parseMcpToolError(response)).toMatchObject({
        error: {
          code: "cleanup_incomplete",
          details: {
            cleanup: "incomplete",
            resources: ["owned static parser reader"],
          },
        },
      });
      expect(JSON.stringify(response)).not.toMatch(
        /retainedOwnedReader|synthetic directory/u,
      );
      expect(ownedFixturePendingCleanupCount(server)).toBe(1);
      vi.mocked(opendir).mockClear();
      expect((await client.callTool(requests[1]!)).isError).toBe(true);
      expect(opendir).not.toHaveBeenCalled();
      const retry = retryOwnedFixtureCleanup(server);
      const shutdown = server.close();
      expect(retryOwnedFixtureCleanup(server)).toBe(retry);
      await expect(retry).rejects.toMatchObject({ cleanupIncomplete: true });
      await expect(shutdown).rejects.toBeInstanceOf(AggregateError);
      expect(nativeCloses).toBe(1);
      expect(ownedFixturePendingCleanupCount(server)).toBe(1);
      expect(response.isError).toBe(true);
    } finally {
      vi.restoreAllMocks();
      for (const close of emergency) await close();
      await client.close();
      if (ownedFixturePendingCleanupCount(server) > 0)
        await expect(server.close()).rejects.toBeInstanceOf(AggregateError);
      else await server.close();
      await session.close();
    }
  },
);
