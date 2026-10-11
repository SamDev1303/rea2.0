import { createHash } from "node:crypto";
import fs, { opendir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  ownedStaticFixturePendingCleanupCount,
  revalidateOwnedStaticFixtureInventory,
  retryOwnedStaticFixtureCleanup,
  sealOwnedStaticFixtureInventory,
  withOwnedStaticFixtureInventory,
} from "../../../src/application/investigationSafety/OwnedStaticFixtureInventory.js";
import { traceDylibResolution } from "../../../src/artifacts/apple/DylibResolutionReader.js";
import { machoImage } from "../../../src/artifacts/apple/MachoImage.fixture.js";
import { OwnedStaticFixtureCleanupFailure } from "../../../src/filesystem/OwnedStaticResource.js";
import { DirectoryArtifactReader } from "../../../src/artifacts/DirectoryArtifactReader.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: vi.fn(actual.realpath),
    opendir: vi.fn(actual.opendir),
  };
});
const emergency: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const release of emergency.splice(0)) await release();
});
const fixture = async () => {
  const root = await createTestTempDirectory("rea-directory-closure-");
  const path = join(root, "Image");
  const bytes = Buffer.from(machoImage({}));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(path, bytes);
  const token = await sealOwnedStaticFixtureInventory({
    roots: [root],
    directories: [],
    files: [{ path, sha256 }],
  });
  return { root, path, sha256, token };
};
it("rejects a newly enumerated undeclared symlink without canonicalizing its destination", async () => {
  const { root, token } = await fixture();
  const outside = await createTestTempDirectory(
    "rea-directory-closure-outside-",
  );
  const unlisted = join(root, "unlisted");
  await fs.symlink(outside, unlisted);
  vi.mocked(realpath).mockClear();
  await expect(revalidateOwnedStaticFixtureInventory(token)).rejects.toThrow();
  expect(realpath).not.toHaveBeenCalledWith(unlisted);
  expect(realpath).not.toHaveBeenCalledWith(outside);
});
it.each([false, true])(
  "retains the dyld enumeration reader after directory cleanup fails (primary=%s)",
  async (primaryFailure) => {
    const { root, path, sha256, token } = await fixture();
    const primary = new Error("synthetic traversal failure");
    const cleanup = new Error("synthetic directory cleanup failure");
    let nativeCloses = 0;
    vi.mocked(opendir).mockImplementation(async (selected, options) => {
      const handle = await fs.opendir(selected, options);
      const originalClose = handle.close.bind(handle);
      emergency.push(originalClose);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        nativeCloses += 1;
        throw cleanup;
      });
      if (primaryFailure) vi.spyOn(handle, "read").mockRejectedValue(primary);
      return handle;
    });
    const failure = await withOwnedStaticFixtureInventory(
      token,
      {},
      "trace_dylib_resolution",
      () =>
        traceDylibResolution({
          rootPath: root,
          targetPath: path,
          targetSha256: sha256,
          enumerateRoots: true,
          parameters: {},
        }),
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(OwnedStaticFixtureCleanupFailure);
    const retained = failure as OwnedStaticFixtureCleanupFailure;
    expect(retained.retainedOwnedReader).toBeInstanceOf(
      DirectoryArtifactReader,
    );
    expect(retained.retainedOwnedFile).toBeUndefined();
    expect(retained.retainedOwnedDirectory).toBeUndefined();
    expect(causeIncludes(retained.cleanupCause, cleanup)).toBe(true);
    if (primaryFailure) expect(causeIncludes(retained, primary)).toBe(true);
    expect(projectAnalysisError(retained)).toMatchObject({
      code: "cleanup_incomplete",
    });
    expect(ownedStaticFixturePendingCleanupCount(token)).toBe(1);
    const one = retryOwnedStaticFixtureCleanup(token);
    const two = retryOwnedStaticFixtureCleanup(token);
    expect(one).toBe(two);
    await expect(one).rejects.toMatchObject({ cleanupIncomplete: true });
    expect(ownedStaticFixturePendingCleanupCount(token)).toBe(1);
    expect(nativeCloses).toBe(1);
  },
);

const causeIncludes = (
  value: unknown,
  expected: unknown,
  seen = new Set<unknown>(),
): boolean => {
  if (value === expected) return true;
  if (!(value instanceof Error) || seen.has(value)) return false;
  seen.add(value);
  return (
    causeIncludes(value.cause, expected, seen) ||
    (value instanceof AggregateError &&
      value.errors.some((cause: unknown) =>
        causeIncludes(cause, expected, seen),
      ))
  );
};
