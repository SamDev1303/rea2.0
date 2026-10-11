import { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import { ProcessCaptureError } from "../../../src/process/capture/ProcessCaptureError.js";

export const ownedCaptureFailure = (
  failure: AnalysisError,
  signal?: AbortSignal,
): AnalysisError => {
  if (
    signal?.aborted &&
    !failure.cleanupIncomplete &&
    failure instanceof ProcessCaptureError &&
    failure.userCategory === "cancelled"
  ) {
    const reason =
      signal.reason instanceof Error
        ? signal.reason.message
        : String(signal.reason);
    return new ProcessCaptureError(reason, {
      cause: new AggregateError(
        [failure, signal.reason],
        "Owned capture cancellation outcomes",
      ),
      reason: failure.reason,
      userCategory: failure.userCategory,
      userMessage: reason,
      cleanupResources: failure.cleanupResources,
      ...(failure.executionFailure === undefined
        ? {}
        : { executionFailure: failure.executionFailure }),
      ...(failure.partialObservation === undefined
        ? {}
        : { partialObservation: failure.partialObservation }),
      ...(failure.cleanupReport === undefined
        ? {}
        : { cleanupReport: failure.cleanupReport }),
    });
  }
  return failure;
};
