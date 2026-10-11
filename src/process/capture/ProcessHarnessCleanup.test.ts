import { afterEach, expect, it, vi } from "vitest";
import { processScenarioSchema } from "../../domain/process/processScenario.js";
import { captureProcessScenario } from "./ProcessHarness.js";
import { ProcessCaptureResourceScope } from "./ProcessCaptureLifecycle.js";
afterEach(() => vi.restoreAllMocks());
it("reports default lifecycle close failure alongside prelaunch cancellation without spawning", async () => {
  const controller = new AbortController();
  controller.abort();
  const cleanup = new Error("authored default scope close failure");
  const retainedScopes: ProcessCaptureResourceScope[] = [];
  const nativeClose = ProcessCaptureResourceScope.prototype.close;
  vi.spyOn(
    ProcessCaptureResourceScope.prototype,
    "close",
  ).mockImplementationOnce(function (this: ProcessCaptureResourceScope) {
    retainedScopes.push(this);
    return Promise.reject(cleanup);
  });
  const snapshot = vi.fn(async () => {
    throw new Error("pre-aborted request must not snapshot");
  });
  const result = await captureProcessScenario(
    processScenarioSchema.parse({ executable: "/owned/not-dispatched" }),
    controller.signal,
    "darwin",
    {},
    snapshot,
  );
  expect(snapshot).not.toHaveBeenCalled();
  const retained = retainedScopes[0];
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected cancelled cleanup failure");
  expect(result.error).toMatchObject({
    reason: "cleanup_incomplete",
    primaryFailure: expect.objectContaining({ reason: "cancelled" }),
    cleanupCause: cleanup,
    resources: retained,
  });
  expect(result.error.cause).toBeInstanceOf(AggregateError);
  expect((result.error.cause as AggregateError).errors).toMatchObject([
    expect.objectContaining({ reason: "cancelled" }),
    cleanup,
  ]);
  expect(result.error.message).toContain(cleanup.message);
  expect(retained).toBeDefined();
  await nativeClose.call(retained);
  expect(result.error).toHaveProperty("cleanupCause", cleanup);
});
