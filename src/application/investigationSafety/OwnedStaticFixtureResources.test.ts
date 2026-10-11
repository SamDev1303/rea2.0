import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createOwnedAppleStaticSession } from "../binary/OwnedAppleStaticSession.js";
import {
  sealOwnedFixturePolicy,
  digestOwnedFixtureInput,
} from "./OwnedFixturePolicy.js";
import {
  sealOwnedStaticFixtureInventory,
  revalidateOwnedStaticFixtureInventory,
  retryOwnedStaticFixtureCleanup,
  ownedStaticFixturePendingCleanupCount,
} from "./OwnedStaticFixtureInventory.js";
import { OwnedStaticFixtureCleanupFailure } from "./OwnedStaticFixtureResources.js";

const roots: string[] = [];
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const release of cleanup.splice(0)) await release();
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
const fixture = async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "rea-inventory-cleanup-")),
  );
  roots.push(root);
  const file = join(root, "data");
  await fs.writeFile(file, "owned");
  return {
    root,
    file,
    data: {
      roots: [root],
      directories: [],
      files: [
        {
          path: file,
          sha256: createHash("sha256").update("owned").digest("hex"),
        },
      ],
    },
  };
};
const caught = async (
  operation: Promise<unknown>,
): Promise<OwnedStaticFixtureCleanupFailure> => {
  const error: unknown = await operation.catch((cause: unknown) => cause);
  expect(error).toBeInstanceOf(OwnedStaticFixtureCleanupFailure);
  return error as OwnedStaticFixtureCleanupFailure;
};

it.each([true, false])(
  "retains the file owner and cleanup cause with primary read failure=%s",
  async (failRead) => {
    const { file, data } = await fixture();
    const primary = new Error("synthetic primary read failure");
    const closing = new Error("synthetic file close failure");
    const originalOpen = fs.open;
    let attempts = 0;
    vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode);
      if (path === file) {
        const actualClose = handle.close.bind(handle);
        cleanup.push(async () => {
          if (handle.fd >= 0) await actualClose();
        });
        vi.spyOn(handle, "close").mockImplementation(async () => {
          if (++attempts === 1) throw closing;
          await actualClose();
        });
        if (failRead) vi.spyOn(handle, "read").mockRejectedValue(primary);
      }
      return handle;
    });
    const failure = await caught(sealOwnedStaticFixtureInventory(data));
    expect(failure.cause).toBe(failRead ? primary : closing);
    expect(failure.cleanupCause).toBe(closing);
    expect(failure.cleanupIncomplete).toBe(true);
    expect(failure.cleanupResources).toEqual(["owned static inventory file"]);
    expect(failure.retainedOwnedDirectory).toBeUndefined();
    expect(failure.retainedOwnedFile).toBeDefined();
    expect(attempts).toBe(1);
    expect(JSON.stringify(failure)).not.toContain("retainedOwnedFile");
    await failure.retainedOwnedFile!.close();
    expect(attempts).toBe(2);
  },
);

it("preserves a failed revalidation cleanup owner instead of replacing its error", async () => {
  const { file, data } = await fixture();
  const token = await sealOwnedStaticFixtureInventory(data);
  const closing = new Error("synthetic revalidation close failure");
  const originalOpen = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
    const handle = await originalOpen(path, flags, mode);
    if (path === file) {
      const actualClose = handle.close.bind(handle);
      cleanup.push(async () => {
        if (handle.fd >= 0) await actualClose();
      });
      vi.spyOn(handle, "close").mockRejectedValue(closing);
    }
    return handle;
  });
  const failure = await caught(revalidateOwnedStaticFixtureInventory(token));
  expect(failure.retainedOwnedFile).toBeDefined();
  expect(failure.cleanupCause).toBe(closing);
  expect(failure.cleanupIncomplete).toBe(true);
});

it("retains an unconfirmed invalidated file close as sticky cleanup failure", async () => {
  const { file, data } = await fixture();
  const closing = new Error("synthetic post-invalidation close failure");
  const originalOpen = fs.open;
  let attempts = 0;
  vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
    const handle = await originalOpen(path, flags, mode);
    if (path === file) {
      const actualClose = handle.close.bind(handle);
      cleanup.push(async () => {
        if (handle.fd >= 0) await actualClose();
      });
      vi.spyOn(handle, "close").mockImplementation(async () => {
        ++attempts;
        await actualClose();
        throw closing;
      });
    }
    return handle;
  });
  const failure = await caught(sealOwnedStaticFixtureInventory(data));
  expect(failure.retainedOwnedFile?.handle.fd).toBeLessThan(0);
  await expect(failure.retainedOwnedFile!.close()).rejects.toBe(closing);
  expect(failure.cleanupIncomplete).toBe(true);
  expect(attempts).toBe(1);
});

it("retains sticky directory ownership and both primary and close failures without retry masking", async () => {
  const { root, data } = await fixture();
  const primary = new Error("synthetic directory read failure");
  const closing = new Error("synthetic directory close failure");
  const originalOpen = fs.opendir;
  let attempts = 0;
  vi.spyOn(fs, "opendir").mockImplementation(async (path, options) => {
    const handle = await originalOpen(path, options);
    if (path === root) {
      const actualClose = handle.close.bind(handle);
      cleanup.push(actualClose);
      vi.spyOn(handle, "read").mockRejectedValue(primary);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        ++attempts;
        throw closing;
      });
    }
    return handle;
  });
  const failure = await caught(sealOwnedStaticFixtureInventory(data));
  expect(failure.cause).toBe(primary);
  expect(failure.cleanupCause).toBe(closing);
  expect(failure.cleanupResources).toEqual([
    "owned static inventory directory",
  ]);
  expect(failure.retainedOwnedFile).toBeUndefined();
  expect(failure.retainedOwnedDirectory).toBeDefined();
  expect(attempts).toBe(1);
  await expect(failure.retainedOwnedDirectory!.close()).rejects.toBe(closing);
  expect(attempts).toBe(1);
});

it("preserves retained ownership through the policy sealing boundary", async () => {
  const { file, data } = await fixture();
  const closing = new Error("synthetic policy close failure");
  const originalOpen = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
    const handle = await originalOpen(path, flags, mode);
    if (path === file) {
      const actualClose = handle.close.bind(handle);
      cleanup.push(async () => {
        if (handle.fd >= 0) await actualClose();
      });
      vi.spyOn(handle, "close").mockRejectedValue(closing);
    }
    return handle;
  });
  const port = createOwnedAppleStaticSession();
  const failure = await caught(
    sealOwnedFixturePolicy(
      {
        roots: data.roots,
        files: data.files.map((item) => ({ ...item, role: "dependency" })),
        static_inventory: { directories: [] },
        environment: [],
        endpoints: [],
        available_capabilities: ["static"],
        grants: [
          {
            operation: "open_binary",
            input_digest: digestOwnedFixtureInput({ path: file }),
            capability: "static",
            mode: "owned-static",
            port_id: "owned",
          },
        ],
      },
      { owned_static_ports: [{ port_id: "owned", reference: port }] },
    ),
  );
  expect(failure.retainedOwnedFile).toBeDefined();
  expect(failure.cleanupIncomplete).toBe(true);
});

it("banks a retryable file owner, blocks new acquisition, and coalesces overlapping lifecycle retries", async () => {
  const { file, data } = await fixture();
  const token = await sealOwnedStaticFixtureInventory(data);
  const originalOpen = fs.open;
  let attempts = 0;
  const open = vi
    .spyOn(fs, "open")
    .mockImplementation(async (path, flags, mode) => {
      const handle = await originalOpen(path, flags, mode);
      if (path === file) {
        const actualClose = handle.close.bind(handle);
        cleanup.push(async () => {
          if (handle.fd >= 0) await actualClose();
        });
        vi.spyOn(handle, "close").mockImplementation(async () => {
          if (++attempts === 1) throw new Error("synthetic recoverable close");
          await actualClose();
        });
      }
      return handle;
    });
  const failure = await caught(revalidateOwnedStaticFixtureInventory(token));
  expect(ownedStaticFixturePendingCleanupCount(token)).toBe(1);
  open.mockClear();
  await expect(revalidateOwnedStaticFixtureInventory(token)).rejects.toBe(
    failure,
  );
  expect(open).not.toHaveBeenCalled();
  const one = retryOwnedStaticFixtureCleanup(token);
  const two = retryOwnedStaticFixtureCleanup(token);
  expect(one).toBe(two);
  await Promise.all([one, two]);
  expect(attempts).toBe(2);
  expect(ownedStaticFixturePendingCleanupCount(token)).toBe(0);
  expect(failure.cleanupIncomplete).toBe(true);
});
it.each(["file", "directory"] as const)(
  "keeps sticky %s resources banked after explicit retry",
  async (kind) => {
    const { root, file, data } = await fixture();
    const token = await sealOwnedStaticFixtureInventory(data);
    let attempts = 0;
    if (kind === "file") {
      const original = fs.open;
      vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
        const handle = await original(path, flags, mode);
        if (path === file) {
          const close = handle.close.bind(handle);
          vi.spyOn(handle, "close").mockImplementation(async () => {
            ++attempts;
            await close();
            throw new Error("synthetic invalidated close");
          });
        }
        return handle;
      });
    } else {
      const original = fs.opendir;
      vi.spyOn(fs, "opendir").mockImplementation(async (path, options) => {
        const handle = await original(path, options);
        if (path === root) {
          cleanup.push(handle.close.bind(handle));
          vi.spyOn(handle, "close").mockImplementation(async () => {
            ++attempts;
            throw new Error("synthetic sticky directory");
          });
        }
        return handle;
      });
    }
    const failure = await caught(revalidateOwnedStaticFixtureInventory(token));
    expect(ownedStaticFixturePendingCleanupCount(token)).toBe(1);
    await expect(retryOwnedStaticFixtureCleanup(token)).rejects.toMatchObject({
      cleanupIncomplete: true,
    });
    expect(ownedStaticFixturePendingCleanupCount(token)).toBe(1);
    expect(attempts).toBe(1);
    expect(failure.cleanupIncomplete).toBe(true);
  },
);
