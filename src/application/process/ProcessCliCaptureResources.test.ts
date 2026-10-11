import { expect, it } from "vitest";
import { err } from "../../domain/result.js";
import { ProcessCaptureError } from "../../process/capture/ProcessCaptureError.js";
import {
  ProcessCaptureResourceScope,
  ProcessCaptureLifecycleCleanupFailure,
} from "../../process/capture/ProcessCaptureLifecycle.js";
import { projectProcessCliError } from "./ProcessCli.js";
import {
  releaseProcessCliCaptureResources,
  retryPendingProcessCliCaptureCleanup,
} from "./ProcessCliCaptureResources.js";

it("retains the exact service scope and both original capture and cleanup failures", async () => {
  const scope = new ProcessCaptureResourceScope();
  const close = scope.close.bind(scope);
  let allowClose = false;
  let attempts = 0;
  scope.close = async () => {
    attempts++;
    if (!allowClose) throw new Error("capture scope close blocked");
    await close();
  };
  const original = new ProcessCaptureError("original capture failed", {
    executionFailure: "original capture failed",
  });
  let failure: unknown;
  try {
    failure = await releaseProcessCliCaptureResources(
      scope,
      err(original),
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ProcessCaptureLifecycleCleanupFailure);
    const retained = failure as ProcessCaptureLifecycleCleanupFailure;
    expect(retained.resources).toBe(scope);
    expect(retained.primaryFailure).toBe(original);
    expect(retained.cleanupCause).toMatchObject({
      message: "capture scope close blocked",
    });
    expect(projectProcessCliError(retained)).toMatchObject({
      code: "cleanup_incomplete",
      details: { execution_failure: "original capture failed" },
    });
    expect(JSON.stringify(retained)).not.toContain('"resources"');
    await expect(retryPendingProcessCliCaptureCleanup()).rejects.toBeInstanceOf(
      AggregateError,
    );
    expect(attempts).toBe(2);
  } finally {
    allowClose = true;
    await retryPendingProcessCliCaptureCleanup();
  }
  expect(attempts).toBe(3);
});

it("keeps original capture failure and every actual service cleanup retry cause", async () => {
  const resources = new ProcessCaptureResourceScope();
  const close = resources.close.bind(resources);
  const primary = new ProcessCaptureError("primary capture failed");
  const faults = [new Error("first"), new Error("retry1"), new Error("retry2")];
  let allowed = false;
  let index = 0;
  resources.close = async () => {
    if (!allowed) throw faults[index++];
    await close();
  };
  const tree = (v: unknown): unknown[] =>
    v instanceof AggregateError
      ? [v, ...v.errors.flatMap(tree)]
      : v instanceof Error && v.cause !== undefined
        ? [v, ...tree(v.cause)]
        : [v];
  try {
    await releaseProcessCliCaptureResources(resources, err(primary)).catch(
      () => {},
    );
    await retryPendingProcessCliCaptureCleanup().catch(() => {});
    const third = await retryPendingProcessCliCaptureCleanup().catch(
      (cause: unknown) => cause,
    );
    expect(tree(third)).toContain(primary);
    for (const fault of faults) expect(tree(third)).toContain(fault);
    const typed = tree(third).find(
      (x) => x instanceof ProcessCaptureLifecycleCleanupFailure,
    ) as ProcessCaptureLifecycleCleanupFailure;
    expect(typed.primaryFailure).toBe(primary);
    expect(typed.resources).toBe(resources);
  } finally {
    allowed = true;
    await retryPendingProcessCliCaptureCleanup();
  }
});

it("preserves the first capture outcome and every repeated failed release cause", async () => {
  const scope = new ProcessCaptureResourceScope();
  const actualClose = scope.close.bind(scope);
  const primary = new ProcessCaptureError("original producer rejection");
  const replacement = new ProcessCaptureError("later caller outcome");
  const first = new Error("initial release fault");
  const second = new Error("repeated release fault");
  let calls = 0;
  scope.close = async () => {
    throw [first, second][calls++];
  };
  try {
    await releaseProcessCliCaptureResources(scope, err(primary)).catch(
      () => {},
    );
    const failed = await releaseProcessCliCaptureResources(
      scope,
      err(replacement),
    ).catch((cause: unknown) => cause);
    expect(failed).toBeInstanceOf(ProcessCaptureLifecycleCleanupFailure);
    const retained = failed as ProcessCaptureLifecycleCleanupFailure;
    expect(retained.primaryFailure).toBe(primary);
    expect(retained.cleanupCause).toBeInstanceOf(AggregateError);
    expect((retained.cleanupCause as AggregateError).errors).toEqual([
      first,
      second,
    ]);
  } finally {
    scope.close = actualClose;
    await retryPendingProcessCliCaptureCleanup();
  }
});
