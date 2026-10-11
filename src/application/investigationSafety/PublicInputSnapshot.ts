import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { snapshotPlainInput } from "./PlainInputSnapshot.js";

// Matches the SDK's default 10 MiB request transport budget. These are input
// copying limits, independent of private fixture grants and response delivery.
export const PUBLIC_INPUT_SNAPSHOT_MAXIMUM_BYTES = 10 * 1024 * 1024;
const maximumNodes = 100_000;
const maximumDepth = 64;

/** Freeze caller input before asynchronous admission without conferring authority. */
export const snapshotPublicInvestigationInput = <T>(
  operation: string,
  input: T,
): T => {
  const invalid = new AnalysisInputError(operation);
  const exhausted = new AnalysisResourceConstraintError(
    operation,
    "memory",
    "Request snapshot exceeds its bounded data budget.",
    {
      maximum_bytes: PUBLIC_INPUT_SNAPSHOT_MAXIMUM_BYTES,
      maximum_nodes: maximumNodes,
      maximum_depth: maximumDepth,
    },
  );
  try {
    return snapshotPlainInput(input, {
      maximumBytes: PUBLIC_INPUT_SNAPSHOT_MAXIMUM_BYTES,
      maximumNodes,
      maximumDepth,
      invalid: () => invalid,
      exhausted: () => exhausted,
    });
  } catch (cause: unknown) {
    // Only errors created by this boundary may enter its public projection.
    if (cause === invalid || cause === exhausted) throw cause;
    throw invalid;
  }
};
