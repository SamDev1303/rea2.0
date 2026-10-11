import fs from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import {
  withOwnedStaticFixtureFile,
  withOwnedStaticReadBoundary,
} from "../../../src/filesystem/OwnedStaticReadBoundary.js";
import { OwnedStaticFixtureCleanupFailure } from "../../../src/filesystem/OwnedStaticResource.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const failingFile = async () => {
  const root = await createTestTempDirectory("rea-cleanup-mechanics-");
  const path = join(root, "Owned");
  await fs.writeFile(path, "owned");
  const handle = await fs.open(path, "r");
  const close = handle.close.bind(handle);
  vi.spyOn(handle, "close").mockRejectedValue(
    new Error("synthetic failed close"),
  );
  return { handle, release: close };
};
it("captures the cleanup callback before mutation and releases it with the scoped mechanics", async () => {
  const first = vi.fn(),
    replacement = vi.fn();
  const mechanics = {
    acquire: async () => undefined,
    descriptor: () => undefined,
    retainCleanup: first,
  };
  const scoped = await failingFile(),
    unscoped = await failingFile();
  try {
    const failure = await withOwnedStaticReadBoundary(mechanics, async () => {
      mechanics.retainCleanup = replacement;
      await Promise.resolve();
      return withOwnedStaticFixtureFile(scoped.handle, async () => {
        throw new Error("synthetic primary");
      });
    }).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(OwnedStaticFixtureCleanupFailure);
    expect(first).toHaveBeenCalledExactlyOnceWith(failure);
    expect(replacement).not.toHaveBeenCalled();
    const outside = await withOwnedStaticFixtureFile(
      unscoped.handle,
      async () => undefined,
    ).catch((cause: unknown) => cause);
    expect(outside).toBeInstanceOf(OwnedStaticFixtureCleanupFailure);
    expect(first).toHaveBeenCalledTimes(1);
    expect(
      (outside as OwnedStaticFixtureCleanupFailure).retainedOwnedFile?.handle,
    ).toBe(unscoped.handle);
  } finally {
    vi.restoreAllMocks();
    await scoped.release();
    await unscoped.release();
  }
});
it("isolates simultaneous cleanup owners between controller scopes", async () => {
  const one = await failingFile(),
    two = await failingFile();
  const first = vi.fn(),
    second = vi.fn();
  try {
    const failures = await Promise.all(
      [
        { file: one, retain: first },
        { file: two, retain: second },
      ].map(async ({ file: { handle }, retain }) => {
        return withOwnedStaticReadBoundary(
          {
            acquire: async () => undefined,
            descriptor: () => undefined,
            retainCleanup: retain,
          },
          async () => {
            await Promise.resolve();
            return withOwnedStaticFixtureFile(handle, async () => undefined);
          },
        ).catch((cause: unknown) => cause);
      }),
    );
    expect(first).toHaveBeenCalledExactlyOnceWith(failures[0]);
    expect(second).toHaveBeenCalledExactlyOnceWith(failures[1]);
    expect(
      (failures[0] as OwnedStaticFixtureCleanupFailure).retainedOwnedFile
        ?.handle,
    ).toBe(one.handle);
    expect(
      (failures[1] as OwnedStaticFixtureCleanupFailure).retainedOwnedFile
        ?.handle,
    ).toBe(two.handle);
  } finally {
    vi.restoreAllMocks();
    await one.release();
    await two.release();
  }
});
