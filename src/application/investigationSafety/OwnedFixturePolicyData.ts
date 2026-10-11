import { z } from "zod";
import { snapshotPlainInput } from "./PlainInputSnapshot.js";
import { CLI_COMMAND_NAMES } from "../../cliCommandNames.js";
import { TOOL_EFFECTS } from "../../contracts/toolEffects.js";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import { digestCanonicalValue } from "../../domain/canonicalDigest.js";

export const normalizeOwnedFixtureOperation = (operation: string): string =>
  operation.replaceAll("-", "_");
export const OWNED_TIMED_FIXTURE_CAPABILITY = "owned-timed-process-capture";
// This bounds V8 old-space only; it does not impose a total RSS limit.
export const OWNED_TIMED_FIXTURE_HEAP_ARGUMENT = "--max-old-space-size=64";
const knownOperations = new Set(
  [...CLI_COMMAND_NAMES, ...Object.keys(TOOL_EFFECTS)].map(
    normalizeOwnedFixtureOperation,
  ),
);
/** These operations reach only the controller's substituted binary/session port. */
const stubOperations = new Set([
  "decompile",
  "function",
  "instructions",
  "xrefs",
  "trace",
  "search",
  "close_binary",
  "binary_session",
  "binary_overview",
  "procedure_pseudo_code",
  "analyze_function",
  "read_function_instructions",
  "trace_feature",
  "search_strings",
  "search_procedures",
  "address_name",
  "comment",
  "current_address",
  "current_procedure",
  "current_document",
  "goto_address",
  "inline_comment",
  "list_bookmarks",
  "list_documents",
  "list_names",
  "list_procedures",
  "list_segments",
  "list_strings",
  "next_address",
  "prev_address",
  "procedure_address",
  "procedure_assembly",
  "procedure_callees",
  "procedure_callers",
  "procedure_info",
  "procedure_references",
  "resolve_containing_procedure",
  "set_address_name",
  "set_addresses_names",
  "set_bookmark",
  "set_comment",
  "set_inline_comment",
  "unset_bookmark",
  "get_objc_classes",
  "get_objc_protocols",
  "batch_decompile",
  "get_call_graph",
  "analyze_swift_types",
  "find_xrefs_to_name",
  "trace_call_path",
  "get_navigation_context",
  "inspect_address_context",
  "read_bytes",
  "address_to_file_offset",
  "trace_native_values",
  "trace_native_ui_action",
  "inspect_native_instruction",
  "resolve_native_call_targets",
  "inspect_native_data_type",
  "inspect_native_load_image",
  "annotate_native_function",
  "inspect_native_api",
  "inspect_native_dispatch_metadata",
  "inspect_macho",
  "inspect_signature",
  "inspect_plist",
  "list_architectures",
  "demangle_swift",
]);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const name = z.string().min(1).max(128);
const ownedFixturePolicySchema = z.strictObject({
  roots: z.array(z.string().min(1).max(4096)).max(32),
  files: z
    .array(
      z.strictObject({
        path: z.string().min(1).max(4096),
        sha256: digest,
        role: z.enum(["executable", "scenario", "dependency"]),
      }),
    )
    .max(256),
  static_inventory: z
    .strictObject({
      directories: z.array(z.string().min(1).max(4096)).max(256),
    })
    .optional(),
  endpoints: z.array(z.string().min(1).max(4096)).max(32),
  environment: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/u),
        value: z.string().max(8192),
      }),
    )
    .max(64),
  available_capabilities: z.array(name).max(128),
  grants: z
    .array(
      z.strictObject({
        operation: name,
        input_digest: digest,
        capability: name,
        mode: z.enum(["owned-files", "nonexecuting-stub", "owned-static"]),
        port_id: name.optional(),
      }),
    )
    .min(1)
    .max(1024),
});
export type OwnedFixturePolicyData = z.infer<typeof ownedFixturePolicySchema>;
/** Timed callbacks require an explicitly selected, credential-free process grant. */
export const validateOwnedTimedFixtureGrant = (
  data: OwnedFixturePolicyData,
  grant: OwnedFixturePolicyData["grants"][number],
): void => {
  if (
    grant.capability === OWNED_TIMED_FIXTURE_CAPABILITY &&
    (grant.mode !== "owned-files" ||
      data.environment.length !== 0 ||
      data.endpoints.length !== 0)
  )
    throw ownedFixtureUnavailable(grant.operation);
};
// Narrow startup profile; adding a name requires review of its Node/native
// startup effects as well as validation of its complete value.
const fixtureEnvironmentNames = new Set([
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "REA_LOG_LEVEL",
  "HOME",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "REA_FIXTURE_ENDPOINT",
]);
export const isSupportedOwnedFixtureEnvironmentName = (name: string): boolean =>
  fixtureEnvironmentNames.has(name);

export const ownedFixtureUnavailable = (
  operation: string,
): AnalysisCapabilityUnavailableError =>
  new AnalysisCapabilityUnavailableError(
    "rea2-owned-fixture",
    operation,
    "No matching sealed controller-owned fixture capability is available, or its identity changed.",
    {
      userMessage:
        "Owned fixture admission is unavailable; public protected-host denial remains in force.",
    },
  );
/** Fixture grants retain their smaller fixed budget; public requests use a separate snapshot. */
export const snapshotOwnedFixtureInput = <T>(input: T): T => {
  try {
    return snapshotPlainInput(input, {
      maximumBytes: 1024 * 1024,
      maximumNodes: 10000,
      maximumDepth: 64,
      invalid: () => ownedFixtureUnavailable("fixture_input"),
      exhausted: () => ownedFixtureUnavailable("fixture_input"),
    });
  } catch {
    throw ownedFixtureUnavailable("fixture_input");
  }
};
export const digestOwnedFixtureInput = (input: unknown): string => {
  try {
    return digestCanonicalValue(snapshotOwnedFixtureInput(input));
  } catch {
    throw ownedFixtureUnavailable("fixture_input");
  }
};

export const parseOwnedFixturePolicy = (
  value: unknown,
): OwnedFixturePolicyData => ownedFixturePolicySchema.parse(value);
export const isKnownOwnedFixtureOperation = (operation: string): boolean =>
  knownOperations.has(normalizeOwnedFixtureOperation(operation));
export const isNonexecutingOwnedFixtureOperation = (
  operation: string,
): boolean => stubOperations.has(normalizeOwnedFixtureOperation(operation));
