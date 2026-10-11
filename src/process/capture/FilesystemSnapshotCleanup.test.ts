import fs, { open, opendir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { parseProcessScenario } from "../../domain/process/processScenario.js";
import { hashFile, snapshotRoots } from "./FilesystemSnapshot.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: vi.fn(actual.open),
    opendir: vi.fn(actual.opendir),
  };
});
const emergency: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of emergency.splice(0)) await close();
});

it.each([false, true])(
  "retains a real snapshot file after close failure (primary=%s)",
  async (primaryFails) => {
    const root = await createTestTempDirectory("rea-snapshot-close-");
    const path = join(root, "observed");
    await fs.writeFile(path, "original fixture bytes");
    const expected = await fs.lstat(path);
    const primary = new Error("owned snapshot read failed");
    const cleanup = new Error("owned snapshot file close failed");
    let actualHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
    vi.mocked(open).mockImplementation(async (selected, flags, mode) => {
      const handle = await fs.open(selected, flags, mode);
      actualHandle = handle;
      const actualClose = handle.close.bind(handle);
      emergency.push(async () => {
        if (handle.fd >= 0) await actualClose();
      });
      vi.spyOn(handle, "close").mockRejectedValue(cleanup);
      if (primaryFails) vi.spyOn(handle, "read").mockRejectedValue(primary);
      return handle;
    });
    const failure = await hashFile(path, expected, 1024).catch(
      (cause: unknown) => cause,
    );
    expect(failure).toMatchObject({
      cleanupCause: cleanup,
      cause: primaryFails ? primary : cleanup,
    });
    expect(failure).toHaveProperty("retainedOwnedFile.handle", actualHandle);
    expect(failure).toHaveProperty("resources.pendingCount", 1);
  },
);

it.each([false, true])(
  "retains a real snapshot directory after close failure (primary=%s)",
  async (primaryFails) => {
    const root = await createTestTempDirectory("rea-snapshot-dir-close-");
    const primary = new Error("owned directory read failed");
    const cleanup = new Error("owned directory close failed");
    let actualDir: Awaited<ReturnType<typeof fs.opendir>> | undefined;
    vi.mocked(opendir).mockImplementation(async (selected, options) => {
      const dir = await fs.opendir(selected, options);
      actualDir = dir;
      const actualClose = dir.close.bind(dir);
      emergency.push(actualClose);
      vi.spyOn(dir, "close").mockRejectedValue(cleanup);
      if (primaryFails) vi.spyOn(dir, "read").mockRejectedValue(primary);
      // Expose the same real read/close lease to the old implicit iterator path.
      // The production fix uses explicit read and never invokes this iterator.
      dir[Symbol.asyncIterator] = async function* () {
        try {
          while (true) {
            const child = await dir.read();
            if (child === null) return undefined;
            yield child;
          }
        } finally {
          await dir.close();
        }
      };
      return dir;
    });
    const scenario = parseProcessScenario({
      executable: process.execPath,
      working_directory: root,
      filesystem_observation_paths: [root],
    });
    const failure = await snapshotRoots(scenario).catch(
      (cause: unknown) => cause,
    );
    expect(failure).toMatchObject({
      cleanupCause: cleanup,
      cause: primaryFails ? primary : cleanup,
    });
    expect(failure).toHaveProperty("retainedOwnedDirectory.handle", actualDir);
    expect(failure).toHaveProperty("resources.pendingCount", 1);
  },
);
