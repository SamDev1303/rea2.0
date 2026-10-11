import fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import {
  ProcessObservationCleanupFailure,
  ProcessObservationResources,
} from "./ProcessObservationResources.js";

const emergency: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of emergency.splice(0)) await close();
});
const file = async () => {
  const root = await createTestTempDirectory("rea-observation-owner-");
  const path = join(root, "fixture");
  await fs.writeFile(path, "authored fixture");
  const handle = await fs.open(path, "r");
  const nativeClose = handle.close.bind(handle);
  emergency.push(async () => {
    if (handle.fd >= 0) await nativeClose();
  });
  return { path, handle, nativeClose };
};

it.each([false, true])(
  "retries the same real file once across overlapping cleanup calls (primary=%s)",
  async (primaryFails) => {
    const { path, handle, nativeClose } = await file();
    const scope = new ProcessObservationResources();
    const primary = new Error("authored read failure");
    const cleanup = new Error("authored native close failure");
    let closes = 0;
    vi.spyOn(handle, "close").mockImplementation(async () => {
      if (++closes === 1) throw cleanup;
      await nativeClose();
    });
    const result = await scope
      .withFile(path, handle, async () => {
        if (primaryFails) throw primary;
        return "complete";
      })
      .catch((cause: unknown) => cause);
    expect(result).toBeInstanceOf(ProcessObservationCleanupFailure);
    const failure = result as ProcessObservationCleanupFailure;
    expect(failure.cause).toBe(primaryFails ? primary : cleanup);
    expect(failure.cleanupCause).toBe(cleanup);
    expect(failure.resources).toBe(scope);
    expect(failure.retainedOwnedFile?.handle).toBe(handle);
    expect(failure.primaryOutcome).toEqual(
      primaryFails
        ? { kind: "failed", cause: primary }
        : { kind: "completed", value: "complete" },
    );
    expect(scope.pendingCount).toBe(1);
    const a = scope.retryCleanup(),
      b = scope.close();
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(closes).toBe(2);
    expect(scope.pendingCount).toBe(0);
    expect(handle.fd).toBe(-1);
    expect(failure.cleanupIncomplete).toBe(true);
    expect(failure.cleanupCause).toBe(cleanup);
  },
);

it("retains an invalidated real file owner without trying to close it again", async () => {
  const { path, handle, nativeClose } = await file();
  const scope = new ProcessObservationResources();
  const cleanup = new Error("native close rejected after invalidation");
  let closes = 0;
  vi.spyOn(handle, "close").mockImplementation(async () => {
    closes += 1;
    await nativeClose();
    throw cleanup;
  });
  const failure = await scope
    .withFile(path, handle, async () => "complete")
    .catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(ProcessObservationCleanupFailure);
  await expect(scope.close()).rejects.toBeInstanceOf(AggregateError);
  await expect(scope.retryCleanup()).rejects.toMatchObject({
    errors: [
      expect.objectContaining({ cleanupCause: cleanup, resources: scope }),
    ],
  });
  expect(scope.pendingCount).toBe(1);
  expect(closes).toBe(1);
});

it("retains the real directory owner and both failures across explicit retries", async () => {
  const root = await createTestTempDirectory("rea-observation-directory-");
  const dir = await fs.opendir(root);
  const nativeClose = dir.close.bind(dir);
  emergency.push(nativeClose);
  const scope = new ProcessObservationResources();
  const primary = new Error("directory enumeration failed");
  const cleanup = new Error("directory close was not confirmed");
  const close = vi.spyOn(dir, "close").mockRejectedValue(cleanup);
  const result = await scope
    .withDirectory(root, dir, async () => {
      throw primary;
    })
    .catch((cause: unknown) => cause);
  expect(result).toBeInstanceOf(ProcessObservationCleanupFailure);
  const failure = result as ProcessObservationCleanupFailure;
  expect(failure.cause).toBe(primary);
  expect(failure.retainedOwnedDirectory?.handle).toBe(dir);
  const one = scope.close(),
    two = scope.retryCleanup();
  expect(one).toBe(two);
  await expect(one).rejects.toMatchObject({
    errors: [
      expect.objectContaining({
        cause: primary,
        cleanupCause: cleanup,
        resources: scope,
      }),
    ],
  });
  expect(close).toHaveBeenCalledTimes(1);
  expect(scope.pendingCount).toBe(1);
});

it("drains an active lease before lifecycle cleanup without turning its failure into success", async () => {
  const { path, handle, nativeClose } = await file();
  const scope = new ProcessObservationResources();
  const primary = new Error("deferred observation failed");
  const cleanup = new Error("first close failed");
  let release!: () => void;
  const pause = new Promise<void>((resolve) => {
    release = resolve;
  });
  let closes = 0;
  vi.spyOn(handle, "close").mockImplementation(async () => {
    if (++closes === 1) throw cleanup;
    await nativeClose();
  });
  const operation = scope.withFile(path, handle, async () => {
    await pause;
    throw primary;
  });
  // Observe rejection immediately, before allowing the authored read to finish.
  const rejection = expect(operation).rejects.toMatchObject({
    cause: primary,
    cleanupCause: cleanup,
  });
  let drained = false;
  const close = scope.close();
  void close.then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  expect(closes).toBe(0);
  release();
  await rejection;
  await close;
  expect(closes).toBe(2);
  expect(scope.pendingCount).toBe(0);
});

it("takes ownership of a late supplied handle but never reads through a closed scope", async () => {
  const scope = new ProcessObservationResources();
  await scope.close();
  const { path, handle } = await file();
  const consume = vi.fn(async () => "not read");
  await expect(scope.withFile(path, handle, consume)).rejects.toMatchObject({
    reason: "capture_failed",
  });
  expect(consume).not.toHaveBeenCalled();
  expect(handle.fd).toBe(-1);
  expect(scope.pendingCount).toBe(0);
});
