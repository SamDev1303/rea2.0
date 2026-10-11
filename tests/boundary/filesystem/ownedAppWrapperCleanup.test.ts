import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import fs, { opendir } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import {
  ownedFixturePendingCleanupCount,
  retryOwnedFixtureCleanup,
} from "../../../src/application/investigationSafety/OwnedFixturePolicy.js";
import { ownedBundleCleanupFixture } from "../../fixtures/ownedBundleCleanup.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, opendir: vi.fn(actual.opendir) };
});

it.each([false, true])(
  "retains app Wrapper directory after failed cleanup (read failure=%s)",
  async (failRead) => {
    const { wrapper, session, server, request } =
      await ownedBundleCleanupFixture(true);
    const client = new Client({ name: "wrapper-close", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    let closes = 0;
    let emergency: (() => Promise<void>) | undefined;
    try {
      vi.mocked(opendir).mockImplementation(async (path, options) => {
        const directory = await fs.opendir(path, options);
        if (path === wrapper) {
          const close = directory.close.bind(directory);
          emergency = close;
          vi.spyOn(directory, Symbol.asyncIterator).mockImplementation(
            async function* () {
              try {
                while (true) {
                  const entry = await directory.read();
                  if (entry === null) break;
                  yield entry;
                }
              } finally {
                await directory.close();
              }
              return undefined;
            },
          );
          if (failRead)
            vi.spyOn(directory, "read").mockRejectedValue(
              new Error("synthetic wrapper traversal"),
            );
          vi.spyOn(directory, "close").mockImplementation(async () => {
            closes++;
            throw new Error("synthetic wrapper cleanup");
          });
        }
        return directory;
      });
      const result = await client.callTool(request);
      expect(result.isError, JSON.stringify(result)).toBe(true);
      expect(ownedFixturePendingCleanupCount(server)).toBe(1);
      expect(JSON.stringify(result)).toContain("cleanup_incomplete");
      const retry = retryOwnedFixtureCleanup(server);
      expect(retryOwnedFixtureCleanup(server)).toBe(retry);
      await expect(Promise.all([retry, server.close()])).rejects.toThrow();
      expect(closes).toBe(1);
      expect(ownedFixturePendingCleanupCount(server)).toBe(1);
    } finally {
      vi.restoreAllMocks();
      await emergency?.();
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  },
);
