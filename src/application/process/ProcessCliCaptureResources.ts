import {
  ProcessCaptureResourceScope,
  ProcessCaptureLifecycleCleanupFailure,
} from "../../process/capture/ProcessCaptureLifecycle.js";
import type { ProcessCapture } from "../../domain/process/processCaptureParsing.js";
import type { Result } from "../../domain/result.js";

const pending = new Map<
  ProcessCaptureResourceScope,
  { captured: Result<ProcessCapture, unknown>; causes: unknown[] }
>();

/** A service caller cannot turn an unresolved capture lease into string-only output. */
export async function releaseProcessCliCaptureResources(
  resources: ProcessCaptureResourceScope,
  captured: Result<ProcessCapture, unknown>,
): Promise<void> {
  try {
    await resources.close();
    pending.delete(resources);
  } catch (cleanup: unknown) {
    const retained = pending.get(resources) ?? { captured, causes: [] };
    retained.causes.push(cleanup);
    pending.set(resources, retained);
    throw new ProcessCaptureLifecycleCleanupFailure(
      resources,
      retained.causes.length === 1
        ? cleanup
        : new AggregateError(
            [...retained.causes],
            "Capture release attempt causes",
          ),
      retained.captured.ok ? undefined : retained.captured.error,
      retained.captured.ok ? retained.captured.value : undefined,
    );
  }
}

/** Retry exactly the scope retained by a failed service call. */
export async function retryProcessCliCaptureCleanup(
  resources: ProcessCaptureResourceScope,
): Promise<void> {
  const retained = pending.get(resources);
  try {
    await resources.close();
    pending.delete(resources);
  } catch (cleanup: unknown) {
    if (retained === undefined) throw cleanup;
    retained.causes.push(cleanup);
    throw new ProcessCaptureLifecycleCleanupFailure(
      resources,
      new AggregateError(
        [...retained.causes],
        "Capture cleanup attempt causes",
      ),
      retained.captured.ok ? undefined : retained.captured.error,
      retained.captured.ok ? retained.captured.value : undefined,
    );
  }
}

/** Explicit default-service shutdown retry holds scopes until cleanup is confirmed. */
export async function retryPendingProcessCliCaptureCleanup(): Promise<void> {
  const outcomes = await Promise.allSettled(
    [...pending.keys()].map(retryProcessCliCaptureCleanup),
  );
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason as unknown] : [],
  );
  if (failures.length)
    throw new AggregateError(
      failures,
      "Process CLI capture cleanup remains incomplete",
    );
}
