import { resolve } from "node:path";

import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { parseUtf8Json } from "./Utf8JsonInput.js";
import {
  canonicalAdmissionPath,
  isProtectedHostPath,
} from "../filesystem/ProtectedPaths.js";
import { readRegularFile } from "./RegularFileRead.js";

/** One MiB is the declared public preview document budget, before JSON parsing. */
export const readInvestigationWorkflowInput = async (
  path: string,
  signal?: AbortSignal,
): Promise<unknown> => {
  signal?.throwIfAborted();
  const selected = resolve(path);
  let canonical: string;
  try {
    canonical = await canonicalAdmissionPath(selected);
  } catch {
    throw new AnalysisInputError("reconcile_investigation", undefined, [
      {
        path: ["path"],
        reason: "invalid_value",
        message: "Investigation input path could not be admitted.",
      },
    ]);
  }
  if (isProtectedHostPath(selected) || isProtectedHostPath(canonical))
    throw new AnalysisInputError("reconcile_investigation", undefined, [
      {
        path: ["path"],
        reason: "invalid_value",
        message: "Protected host paths cannot be investigation inputs.",
      },
    ]);
  const bytes = await readRegularFile(selected, {
    signal,
    maxBytes: 1024 * 1024,
    symlinks: "reject",
    hardlinks: "reject",
  });
  const parsed = parseUtf8Json(bytes, "reconcile_investigation", selected);
  if (!parsed.ok)
    throw new AnalysisInputError("reconcile_investigation", undefined, [
      { path: ["path"], reason: "invalid_format", expected: "JSON" },
    ]);
  return parsed.value;
};
