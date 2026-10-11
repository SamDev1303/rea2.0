import type { ArtifactAnalysisOperation } from "../contracts/artifactToolContracts.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisCapabilityUnavailableError,
  AnalysisUnsupportedTargetError,
} from "../domain/analysisErrorCore.js";
import { ArtifactOperationError } from "../domain/artifactOperationError.js";
import { ArtifactReaderFailure } from "./ArtifactReader.js";

/** Translate one artifact boundary failure while retaining cleanup evidence. */
export const translateArtifactFailure = (
  operation: ArtifactAnalysisOperation,
  cause: unknown,
): AnalysisError => {
  if (cause instanceof AnalysisCapabilityUnavailableError) return cause;
  if (cause instanceof ArtifactReaderFailure)
    return new ArtifactOperationError(
      operation,
      cause.reason,
      cause.details,
      cause.message,
      {
        cause,
        ...(cause.cleanup === undefined ? {} : { cleanup: cause.cleanup }),
        ...(cause.partialObservation === undefined
          ? {}
          : { partialObservation: cause.partialObservation }),
      },
    );
  // Caller-selection and unsupported-target failures are already typed; keep
  // their correction details instead of reducing them to an I/O failure.
  if (
    cause instanceof AnalysisInputError ||
    cause instanceof AnalysisUnsupportedTargetError
  )
    return cause;
  return new ArtifactOperationError(operation, "io", undefined, undefined, {
    cause,
  });
};
