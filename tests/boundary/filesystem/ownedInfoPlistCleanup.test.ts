import { ownedBundleCleanupFixture } from "../../fixtures/ownedBundleCleanup.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import fs, { open } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { withRegularFile } from "../../../src/application/RegularFileRead.js";
import { resolveAppBundleExecutable } from "../../../src/application/AppBundleExecutable.js";
import { OwnedStaticFixtureResourceBank } from "../../../src/application/investigationSafety/OwnedStaticFixtureResources.js";
import { withOwnedStaticReadBoundary } from "../../../src/filesystem/OwnedStaticReadBoundary.js";
import { OwnedStaticFixtureCleanupFailure } from "../../../src/filesystem/OwnedStaticResource.js";
import {
  ownedFixturePendingCleanupCount,
  retryOwnedFixtureCleanup,
} from "../../../src/application/investigationSafety/OwnedFixturePolicy.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

it.each([false, true])(
  "retains Info.plist consumer cleanup through MCP (read failure=%s)",
  async (failRead) => {
    const { plist, session, server, request } =
      await ownedBundleCleanupFixture();
    const client = new Client({ name: "info-plist-cleanup", version: "1" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);
    let closes = 0;
    let emergency: (() => Promise<void>) | undefined;
    const primary = new Error("synthetic Info.plist read failure");
    const cleanup = new Error("synthetic Info.plist close failure");
    try {
      vi.mocked(open).mockImplementation(async (selected, flags, mode) => {
        const handle = await fs.open(selected, flags, mode);
        if (selected === plist) {
          const close = handle.close.bind(handle);
          emergency = async () => {
            if (handle.fd >= 0) await close();
          };
          if (failRead) vi.spyOn(handle, "read").mockRejectedValue(primary);
          vi.spyOn(handle, "close").mockImplementation(async () => {
            if (++closes === 1) throw cleanup;
            await close();
          });
        }
        return handle;
      });
      const response = await client.callTool(request);
      expect(response.isError).toBe(true);
      expect(ownedFixturePendingCleanupCount(server)).toBe(1);
      expect(JSON.stringify(response)).toContain("cleanup_incomplete");
      expect(JSON.stringify(response)).not.toMatch(
        /synthetic Info\.plist|retainedOwned/u,
      );
      const pending = retryOwnedFixtureCleanup(server);
      expect(retryOwnedFixtureCleanup(server)).toBe(pending);
      await Promise.all([pending, server.close()]);
      expect(closes).toBe(2);
      expect(ownedFixturePendingCleanupCount(server)).toBe(0);
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

it("keeps the exact primary failure and close owner in scoped regular reads", async () => {
  const root = await createTestTempDirectory("rea-scoped-regular-cleanup-");
  const path = join(root, "Info.plist");
  await fs.writeFile(path, "authored synthetic bytes");
  const primary = new Error("synthetic primary");
  const cleanup = new Error("synthetic cleanup");
  const retained: OwnedStaticFixtureCleanupFailure[] = [];
  let closeCount = 0;
  let emergency: (() => Promise<void>) | undefined;
  try {
    vi.mocked(open).mockImplementation(async (selected, flags, mode) => {
      if (selected !== path) throw new Error("Undeclared fixture path");
      const handle = await fs.open(selected, flags, mode);
      const close = handle.close.bind(handle);
      emergency = async () => {
        if (handle.fd >= 0) await close();
      };
      vi.spyOn(handle, "close").mockImplementation(async () => {
        if (++closeCount === 1) throw cleanup;
        await close();
      });
      return handle;
    });
    const failure = await withOwnedStaticReadBoundary(
      {
        acquire: async (selected) => {
          if (selected !== path) throw new Error("Undeclared acquisition");
        },
        descriptor: (_selected, metadata) => {
          expect(metadata.isFile()).toBe(true);
        },
        retainCleanup: (value) => {
          retained.push(value);
        },
      },
      () =>
        withRegularFile(path, async () => {
          throw primary;
        }),
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(OwnedStaticFixtureCleanupFailure);
    expect(retained).toEqual([failure]);
    const typed = failure as OwnedStaticFixtureCleanupFailure;
    expect(typed.cause).toBe(primary);
    expect(typed.cleanupCause).toBe(cleanup);
    const owner = typed.retainedOwnedFile;
    expect(owner).toBeDefined();
    await Promise.all([owner!.close(), owner!.close()]);
    expect(closeCount).toBe(2);
  } finally {
    vi.restoreAllMocks();
    await emergency?.();
  }
});

it("preserves cleanup failure from the final bundle resolution phase", async () => {
  const { root, selected, plist, session, server } =
    await ownedBundleCleanupFixture();
  const bank = new OwnedStaticFixtureResourceBank();
  const primary = new Error("synthetic final metadata failure");
  const cleanup = new Error("synthetic final metadata close failure");
  let closes = 0;
  let emergency: (() => Promise<void>) | undefined;
  try {
    vi.mocked(open).mockImplementation(async (path, flags, mode) => {
      const handle = await fs.open(path, flags, mode);
      const close = handle.close.bind(handle);
      emergency = async () => {
        if (handle.fd >= 0) await close();
      };
      vi.spyOn(handle, "close").mockImplementation(async () => {
        if (++closes === 1) throw cleanup;
        await close();
      });
      return handle;
    });
    const result = await withOwnedStaticReadBoundary(
      {
        acquire: async (path) => {
          expect(path.startsWith(root)).toBe(true);
        },
        descriptor: (_path, metadata) => {
          expect(metadata.isFile()).toBe(true);
        },
        retainCleanup: (failure) => bank.retain(failure),
      },
      () =>
        resolveAppBundleExecutable(selected, {
          readFile: (path) => fs.readFile(path),
          realpath: async (path) => {
            if (path === join(selected, "Contents", "MacOS")) {
              return withRegularFile(plist, async () => {
                throw primary;
              });
            }
            return fs.realpath(path);
          },
        }),
    ).catch((cause: unknown) => cause);
    expect(result).toBeInstanceOf(OwnedStaticFixtureCleanupFailure);
    const failure = result as OwnedStaticFixtureCleanupFailure;
    expect(failure.cause).toBe(primary);
    expect(failure.cleanupCause).toBe(cleanup);
    expect(bank.pendingCount).toBe(1);
    await bank.retry();
    expect(closes).toBe(2);
    expect(bank.pendingCount).toBe(0);
  } finally {
    vi.restoreAllMocks();
    await emergency?.();
    await server.close();
    await session.close();
  }
});
