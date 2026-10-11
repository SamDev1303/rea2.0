import { AnalysisCapabilityUnavailableError } from "./analysisErrorCore.js";

/** Recognise a wrapped admission failure without invoking conversion hooks. */
export const containsCapabilityUnavailableCause = (cause: unknown): boolean => {
  const seen = new Set<Error>();
  let current = cause;
  while (current instanceof Error) {
    if (current instanceof AnalysisCapabilityUnavailableError) return true;
    // Malformed wrapper chains cannot justify a successful partial result.
    if (seen.has(current) || seen.size >= 64) return true;
    seen.add(current);
    const descriptor = Object.getOwnPropertyDescriptor(current, "cause");
    if (descriptor === undefined) return false;
    if (!("value" in descriptor)) return true;
    current = descriptor.value;
  }
  return false;
};
