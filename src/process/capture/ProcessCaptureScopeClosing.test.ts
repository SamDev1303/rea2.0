import { expect, it, vi } from "vitest";
import {
  ProcessCaptureLifecycleCleanupFailure,
  ProcessCaptureResourceScope,
} from "./ProcessCaptureLifecycle.js";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

it("one close seals observation admission after an already-started nonclosing retry", async () => {
  const scope = new ProcessCaptureResourceScope();
  const entered = deferred();
  const release = deferred();
  const retry = scope.observationResources.retryCleanup.bind(
    scope.observationResources,
  );
  const held = vi
    .spyOn(scope.observationResources, "retryCleanup")
    .mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      await retry();
    });
  const close = vi.spyOn(scope.observationResources, "close");
  try {
    const retrying = scope.retryCleanup();
    await entered.promise;
    const closing = scope.close();
    release.resolve();
    await Promise.all([retrying, closing]);
    expect(close).toHaveBeenCalledTimes(1);
    const capture = vi.fn(async () => "must not dispatch");
    await expect(scope.run(capture)).rejects.toThrow("lifecycle is closing");
    expect(capture).not.toHaveBeenCalled();
    expect(scope.pendingCount).toBe(0);
  } finally {
    release.resolve();
    held.mockRestore();
    close.mockRestore();
  }
});

it("overlapping close waits for observation sealing and shares one closing completion", async () => {
  const scope = new ProcessCaptureResourceScope();
  const retryEntered = deferred();
  const releaseRetry = deferred();
  const closeEntered = deferred();
  const releaseClose = deferred();
  const retry = scope.observationResources.retryCleanup.bind(
    scope.observationResources,
  );
  const nativeClose = scope.observationResources.close.bind(
    scope.observationResources,
  );
  const held = vi
    .spyOn(scope.observationResources, "retryCleanup")
    .mockImplementationOnce(async () => {
      retryEntered.resolve();
      await releaseRetry.promise;
      await retry();
    });
  const close = vi
    .spyOn(scope.observationResources, "close")
    .mockImplementationOnce(async () => {
      closeEntered.resolve();
      await releaseClose.promise;
      await nativeClose();
    });
  try {
    const retrying = scope.retryCleanup();
    await retryEntered.promise;
    const closing = scope.close();
    expect(scope.close()).toBe(closing);
    expect(scope.retryCleanup()).toBe(closing);
    let settled = false;
    void closing.then(() => {
      settled = true;
    });
    releaseRetry.resolve();
    await closeEntered.promise;
    expect(settled).toBe(false);
    expect(close).toHaveBeenCalledTimes(1);
    releaseClose.resolve();
    await Promise.all([retrying, closing]);
    expect(settled).toBe(true);
  } finally {
    releaseRetry.resolve();
    releaseClose.resolve();
    held.mockRestore();
    close.mockRestore();
  }
});

it("retains retry and overlapping close failures with exact owners until an explicit retry", async () => {
  const scope = new ProcessCaptureResourceScope();
  const processFailure = new Error("inert temporary-root cleanup failed");
  const retryFailure = new Error("inert observation retry failed");
  const closeFailure = new Error("inert observation close failed");
  let failRemoval = true;
  await scope.release({
    timers: new Set(),
    terminal: undefined,
    renderer: undefined,
    runId: "authored-inert-no-process",
    temporaryRoot: "/authored/inert-not-acquired",
    host: {
      platform: "darwin",
      cleanupProcessGroup: async () => ({ cleaned: true, signaled: false }),
      verifyTokenOwnedProcesses: async () => ({
        cleaned: true,
        signaled: false,
      }),
      removeTemporaryRoot: async () => {
        if (failRemoval) throw processFailure;
      },
    },
  });
  const entered = deferred();
  const release = deferred();
  const held = vi
    .spyOn(scope.observationResources, "retryCleanup")
    .mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw retryFailure;
    });
  const close = vi
    .spyOn(scope.observationResources, "close")
    .mockRejectedValue(closeFailure);
  try {
    const retrying = scope.retryCleanup();
    const observedRetry = retrying.catch((cause: unknown) => cause);
    await entered.promise;
    const closing = scope.close();
    expect(scope.close()).toBe(closing);
    expect(scope.retryCleanup()).toBe(closing);
    const observedClose = closing.catch((cause: unknown) => cause);
    release.resolve();
    const originalFailure: unknown = await observedRetry;
    const failure: unknown = await observedClose;
    expect(failure).toBeInstanceOf(ProcessCaptureLifecycleCleanupFailure);
    const retained = failure as ProcessCaptureLifecycleCleanupFailure;
    expect(retained.resources).toBe(scope);
    expect((retained.cleanupCause as AggregateError).errors).toEqual([
      originalFailure,
      closeFailure,
    ]);
    const first = originalFailure as ProcessCaptureLifecycleCleanupFailure;
    expect(first.resources).toBe(scope);
    const causes = (first.cleanupCause as AggregateError).errors;
    expect(causes).toContain(retryFailure);
    expect((causes[0].cause as AggregateError).errors).toContain(
      processFailure,
    );
    expect(scope.pendingCount).toBe(1);
    expect(close).toHaveBeenCalledTimes(1);
    held.mockRestore();
    close.mockRestore();
    failRemoval = false;
    await scope.close();
    expect(scope.pendingCount).toBe(0);
    expect((retained.cleanupCause as AggregateError).errors).toContain(
      closeFailure,
    );
  } finally {
    release.resolve();
    held.mockRestore();
    close.mockRestore();
  }
});

it("waits for active capture settlement before sealing observation admission", async () => {
  const scope = new ProcessCaptureResourceScope();
  const entered = deferred();
  const release = deferred();
  const close = vi.spyOn(scope.observationResources, "close");
  try {
    const running = scope.run(async () => {
      entered.resolve();
      await release.promise;
      return "authored inert result";
    });
    await entered.promise;
    const closing = scope.close();
    expect(close).not.toHaveBeenCalled();
    release.resolve();
    await expect(running).resolves.toBe("authored inert result");
    await closing;
    expect(close).toHaveBeenCalledTimes(1);
    expect(scope.pendingCount).toBe(0);
  } finally {
    release.resolve();
    close.mockRestore();
  }
});
