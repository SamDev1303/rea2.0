import fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { processScenarioSchema } from "../../domain/process/processScenario.js";
import { emptyProcessCapture } from "../../domain/process/processCapture.fixture.js";
import {
  ProcessCaptureLifecycleCleanupFailure,
  ProcessCaptureResourceScope,
  observeSelectedExecutable,
  prepareProcessCapture,
  resolveProcessResult,
} from "./ProcessCaptureLifecycle.js";
import { ProcessCaptureError } from "./ProcessCaptureError.js";
const emergency: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of emergency.splice(0)) await close();
});

it("shares selected-file ownership with the capture scope and coalesces explicit close", async () => {
  const root = await createTestTempDirectory("rea-selected-scope-");
  const path = join(root, "authored-fixture");
  await fs.writeFile(path, "not a launched program");
  const scope = new ProcessCaptureResourceScope();
  const collection = scope.observationResources;
  expect(Reflect.set(scope, "observationResources", {})).toBe(false);
  expect(scope.observationResources).toBe(collection);
  const cleanup = new Error("selected descriptor close failed");
  let closes = 0;
  const failure = await observeSelectedExecutable(
    path,
    undefined,
    {
      open: async (selected, flags) => {
        const handle = await fs.open(selected, flags);
        const close = handle.close.bind(handle);
        emergency.push(async () => {
          if (handle.fd >= 0) await close();
        });
        vi.spyOn(handle, "close").mockImplementation(async () => {
          if (++closes === 1) throw cleanup;
          await close();
        });
        return handle;
      },
      stat: (selected) => fs.stat(selected, { bigint: true }),
    },
    scope.observationResources,
  ).catch((cause: unknown) => cause);
  expect(failure).toHaveProperty("resources", scope.observationResources);
  expect(scope.pendingCount).toBe(1);
  const a = scope.close(),
    b = scope.close();
  expect(a).toBe(b);
  await Promise.all([a, b]);
  expect(closes).toBe(2);
  expect(scope.pendingCount).toBe(0);
  expect(failure).toHaveProperty("cleanupCause", cleanup);
});

it("attempts observation cleanup even while process-resource cleanup fails and retains both collections", async () => {
  const root = await createTestTempDirectory("rea-joined-cleanup-");
  const path = join(root, "observed");
  await fs.writeFile(path, "fixture");
  const scope = new ProcessCaptureResourceScope();
  const primary = new Error("capture failed before cleanup");
  const processFailure = new Error("temporary root removal failed");
  const fileFailure = new Error("first descriptor close failed");
  let failing = true,
    closes = 0;
  const handle = await fs.open(path, "r");
  const nativeClose = handle.close.bind(handle);
  emergency.push(async () => {
    if (handle.fd >= 0) await nativeClose();
  });
  vi.spyOn(handle, "close").mockImplementation(async () => {
    if (++closes === 1) throw fileFailure;
    await nativeClose();
  });
  await expect(
    scope.observationResources.withFile(path, handle, async () => "captured"),
  ).rejects.toHaveProperty("cleanupCause", fileFailure);
  const report = await scope.release({
    timers: new Set(),
    terminal: undefined,
    renderer: undefined,
    runId: "authored-no-process",
    temporaryRoot: root,
    host: {
      platform: "darwin",
      cleanupProcessGroup: async () => ({ cleaned: true, signaled: false }),
      verifyTokenOwnedProcesses: async () => ({
        cleaned: true,
        signaled: false,
      }),
      removeTemporaryRoot: async () => {
        if (failing) throw processFailure;
      },
    },
  });
  const initial = (() => {
    try {
      resolveProcessResult(undefined, primary, report);
    } catch (cause: unknown) {
      return cause;
    }
    throw new Error("expected report failure");
  })();
  expect(initial).toHaveProperty("cause", primary);
  expect(initial).toHaveProperty("cleanupCauses.0", processFailure);
  expect(scope.pendingCount).toBe(2);
  const a = scope.close(),
    b = scope.retryCleanup();
  expect(a).toBe(b);
  const failure = await a.catch((cause: unknown) => cause);
  expect(failure).toBeInstanceOf(ProcessCaptureLifecycleCleanupFailure);
  const retained = failure as ProcessCaptureLifecycleCleanupFailure;
  expect(retained.resources).toBe(scope);
  const outer = retained.cleanupCause as AggregateError;
  expect(outer.errors).toHaveLength(1);
  expect((outer.errors[0] as ProcessCaptureError).cause).toBeInstanceOf(
    AggregateError,
  );
  expect(
    ((outer.errors[0] as ProcessCaptureError).cause as AggregateError).errors,
  ).toContain(processFailure);
  expect(closes).toBe(2);
  expect(handle.fd).toBe(-1);
  expect(scope.observationResources.pendingCount).toBe(0);
  expect(scope.pendingCount).toBe(1);
  failing = false;
  await scope.retryCleanup();
  expect(scope.pendingCount).toBe(0);
  expect(initial).toHaveProperty("cleanupCauses.0", processFailure);
});

it("denies later captures while an observation directory owner remains unresolved", async () => {
  const root = await createTestTempDirectory("rea-dir-scope-");
  const dir = await fs.opendir(root);
  const nativeClose = dir.close.bind(dir);
  emergency.push(nativeClose);
  const scope = new ProcessCaptureResourceScope();
  const cleanup = new Error("unconfirmed directory close");
  const close = vi.spyOn(dir, "close").mockRejectedValue(cleanup);
  await expect(
    scope.observationResources.withDirectory(root, dir, async () => undefined),
  ).rejects.toHaveProperty("cleanupCause", cleanup);
  const operation = vi.fn(async () => "must not capture");
  await expect(scope.run(operation)).rejects.toBeInstanceOf(
    ProcessCaptureLifecycleCleanupFailure,
  );
  expect(operation).not.toHaveBeenCalled();
  expect(scope.pendingCount).toBe(1);
  expect(close).toHaveBeenCalledTimes(1);
});

it("passes the persistent observation collection to prelaunch snapshots", async () => {
  const scope = new ProcessCaptureResourceScope();
  const scenario = processScenarioSchema.parse({
    executable: "/authored/not-dispatched",
  });
  const snapshot = vi.fn(async () => ({
    files: [],
    truncated: false,
    completeRoots: [],
    coverage: emptyProcessCapture().truncation_details.filesystem_before,
  }));
  await prepareProcessCapture(
    scenario,
    undefined,
    snapshot,
    {
      createTemporaryRoot: async () => "/authored/virtual-root",
      captureOwnershipBaseline: async () => [],
      cleanup: async () => undefined,
    },
    scope,
  );
  expect(snapshot).toHaveBeenCalledExactlyOnceWith(
    scenario,
    undefined,
    scope.observationResources,
  );
  await scope.close();
});

it("preserves the original execution reason through a later lifecycle cleanup failure", () => {
  const scope = new ProcessCaptureResourceScope();
  const primary = new ProcessCaptureError("first cleanup failed", {
    reason: "cleanup_incomplete",
    executionFailure: "final snapshot failed",
    cleanupResources: ["temporary_root"],
  });
  const cleanup = new Error("retry cleanup failed");
  const result = new ProcessCaptureLifecycleCleanupFailure(
    scope,
    cleanup,
    primary,
  );
  expect(result.executionFailure).toBe("final snapshot failed");
  expect(result.primaryFailure).toBe(primary);
  expect(result.cleanupCause).toBe(cleanup);
  expect(result.cleanupResources).toEqual([
    "process_capture_lifecycle",
    "temporary_root",
  ]);
  expect((result.cause as AggregateError).errors).toEqual([primary, cleanup]);
});
