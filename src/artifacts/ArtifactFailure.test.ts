import { expect, it } from "vitest";
import { translateArtifactFailure } from "./ArtifactFailure.js";

it("retains the original untyped artifact failure without exposing its details in the safe message", () => {
  const cause = new Error("synthetic private parser diagnostic");
  const failure = translateArtifactFailure("trace_dylib_resolution", cause);
  expect(failure.cause).toBe(cause);
  expect(failure.message).not.toContain(cause.message);
});
