import { lstat } from "node:fs/promises";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import {
  canonicalAdmissionPath,
  isProtectedHostPath,
} from "../../filesystem/ProtectedPaths.js";

/** Audited surfaces that do not execute target code. Unknown operations fail closed. */
const STATIC_OPERATIONS = new Set([
  "reconcile_investigation",
  "prepare_builder_handoff",
  "capabilities",
  "providers",
  "binary_session",
  "doctor",
  "setup",
  "uninstall",
  "update",
  "import_reference_source",
  "analyze_javascript_application",
  "analyze_swift_application",
  "trace_application_feature",
  "trace_javascript_semantics",
  "compare_application_versions",
  "compare_source_to_bundle",
  "compare_javascript_export_shapes",
  "build_reconstruction_obligation_ledger",
  "evaluate_reconstruction_coverage",
  "project_android_application_graph",
  "project_apple_application_graph",
  "inspect_analysis_view",
  "inspect_evidence_bundle",
  "evidence_import",
  "evidence_export",
  "get_evidence_bundle",
  "export_evidence_bundle",
  "import_evidence_bundle",
  "list_unknowns",
  "record_unknown",
  "update_unknown",
  "verify_unknown_resolution",
  "compare_bundles",
  "compare",
  "compare_process_captures",
  "compare_web_captures",
  "compare_web_screenshots",
  "reconcile_javascript_runtime",
  "close_binary",
  "compare_artifacts",
  "compare_functions",
  "find_changed_behavior",
  "build_call_path",
  "correlate_static_and_runtime",
  "verify_reconstruction",
  "import_managed_reconstruction",
  "verify_managed_native_boundaries",
  "project_managed_application_graph",
  "export_web_scripts",
  // Only the maintained, bounded codec runs; target source/maps remain data.
  "trace_web_source_location",
]);

const blocked = (
  operation: string,
  reason: string,
): AnalysisCapabilityUnavailableError =>
  new AnalysisCapabilityUnavailableError(
    "rea2-protected-host",
    operation,
    reason,
    {
      userMessage: reason,
    },
  );

/** No tool argument, environment flag, or imported evidence can grant execution authority. */
export const investigationOperationDenial = (
  operation: string,
): AnalysisCapabilityUnavailableError | undefined =>
  STATIC_OPERATIONS.has(operation.replaceAll("-", "_"))
    ? undefined
    : blocked(
        operation,
        "Host target execution and unfamiliar native parsing are blocked. No verified disposable analysis runner is configured; continue source and internet research. This is an availability limit, not evidence that the target is safe.",
      );

const pathKey = (key: string): boolean =>
  /(?:paths?|roots?|files?|directories|directory|destinations?|scenarios?|bundles?|inputs?|outputs?|left|right|targets?|sources?|captures?|rootDir|dest|uri|url|cwd|workspace|repo|inputJson)$/iu.test(
    key,
  );

const candidatePath = (value: string): string => {
  if (value.startsWith("file:")) return fileURLToPath(value);
  if (value === "~" || value.startsWith("~/"))
    return resolve(userInfo().homedir, value.slice(2));
  if (value.startsWith("~")) throw new Error("Unsupported home alias");
  return value;
};

/** Admit an actual filesystem acquisition separately from semantic report text. */
export const admitInvestigationPath = async (
  operation: string,
  value: string,
): Promise<string> => {
  try {
    const selected = candidatePath(value);
    if (isProtectedHostPath(selected)) throw new Error("Protected path");
    const canonical = await canonicalAdmissionPath(selected);
    if (isProtectedHostPath(selected) || isProtectedHostPath(canonical))
      throw new Error("Protected path");
    const metadata = await lstat(canonical).catch((cause: unknown) => {
      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "ENOENT"
      )
        return undefined;
      throw cause;
    });
    if (metadata?.isFile() && metadata.nlink > 1)
      throw new Error("Multiple file aliases");
    return canonical;
  } catch {
    throw blocked(
      operation,
      "A protected input or output path was rejected before ingestion, or its identity could not be verified. Credential and personal stores are outside investigation scope.",
    );
  }
};

/** Bound recursive input inspection and reject protected paths before a handler runs. */
export const admitInvestigationInput = async (
  operation: string,
  input: unknown,
): Promise<void> => {
  const denial = investigationOperationDenial(operation);
  if (denial !== undefined) throw denial;
  await admitInvestigationPaths(operation, input);
};

// These consumers resolve Evidence in memory; provenance paths never acquire files.
const evidenceMetadataFields: Readonly<Record<string, readonly string[]>> = {
  compare_application_versions: [
    "left",
    "right",
    "left_native_observations",
    "right_native_observations",
  ],
  compare_javascript_export_shapes: ["left", "right"],
  trace_application_feature: ["application", "native_observations"],
  compare_source_to_bundle: ["reference", "application"],
};

/** Inspect typed path fields in data without conferring operation authority. */
export const admitInvestigationPaths = async (
  operation: string,
  input: unknown,
): Promise<void> => {
  const normalized = operation.replaceAll("-", "_");
  const semanticReport = [
    "reconcile_investigation",
    "prepare_builder_handoff",
  ].includes(normalized);
  const semanticFields = evidenceMetadataFields[normalized] ?? [];
  const pending: {
    value: unknown;
    pathBearing: boolean;
    semantic: boolean;
    depth: number;
  }[] = [{ value: input, pathBearing: false, semantic: false, depth: 0 }];
  const seen = new Set<object>();
  let count = 0;
  while (pending.length > 0) {
    if (++count > 10000)
      throw blocked(
        operation,
        "Input inspection exceeds the protected-host resource budget.",
      );
    const item = pending.pop();
    if (item === undefined) break;
    if (item.depth > 64)
      throw blocked(
        operation,
        "Input nesting exceeds the protected-host resource budget.",
      );
    if (
      typeof item.value === "string" &&
      item.pathBearing &&
      !/^https?:/iu.test(item.value) &&
      !/^[\s]*[\[{]/u.test(item.value)
    )
      await admitInvestigationPath(operation, item.value);
    else if (typeof item.value === "object" && item.value !== null) {
      if (seen.has(item.value))
        throw blocked(operation, "Cyclic input is unsupported.");
      seen.add(item.value);
      for (const [key, value] of Object.entries(item.value)) {
        // These public contracts consume `investigation` as a pure report tree;
        // semantic path metadata there never requests secondary filesystem IO.
        const semantic =
          item.semantic ||
          (item.depth === 0 &&
            ((semanticReport && key === "investigation") ||
              semanticFields.includes(key)));
        const pathBearing =
          !semantic &&
          (Array.isArray(item.value) ? item.pathBearing : pathKey(key));
        // Semantic scalar leaves cannot acquire files. Count only containers and
        // typed path candidates against the bounded inspection budget.
        if (
          (typeof value === "object" && value !== null) ||
          (pathBearing && typeof value === "string")
        )
          pending.push({ value, pathBearing, semantic, depth: item.depth + 1 });
      }
    }
  }
};
