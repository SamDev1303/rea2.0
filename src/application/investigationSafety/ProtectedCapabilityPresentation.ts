import type { ToolAvailability } from "../../contracts/toolOutputSchemaPrimitives.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { investigationOperationDenial } from "./InvestigationAdmission.js";

/** Host admission is transport policy, independent of provider support facts. */
export const projectProtectedToolAvailability = (
  inventory: readonly ToolAvailability[],
): readonly ToolAvailability[] =>
  inventory.map((item) => {
    const denial = investigationOperationDenial(item.name);
    if (denial === undefined) return item;
    return {
      ...item,
      available: false,
      reason: "unsupported_host",
      remediation: denial.reason,
      ...(item.default_mode_available === undefined
        ? {}
        : { default_mode_available: false }),
      ...(item.modes === undefined
        ? {}
        : {
            modes: item.modes.map((mode) => ({
              ...mode,
              available: false,
              missing_operations:
                mode.missing_operations.length > 0
                  ? [...mode.missing_operations]
                  : [item.name],
            })),
          }),
    };
  });

const record = (
  value: JsonValue | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const capabilities = (value: JsonValue | undefined): JsonValue | undefined => {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    if (!record(item) || typeof item.operation !== "string") return item;
    const denial = investigationOperationDenial(item.operation);
    return denial === undefined
      ? item
      : {
          ...item,
          available: false,
          reason: denial.reason,
          availability_code: "unsupported_host",
        };
  });
};

/** Never advertise provider support as permission to execute on this host. */
export const projectProtectedProviderStatus = (value: JsonValue): JsonValue => {
  if (!record(value)) return value;
  const projected = capabilities(value.capabilities);
  const candidates = value.analysis_provider_candidates;
  return {
    ...value,
    ...(projected === undefined ? {} : { capabilities: projected }),
    ...(!Array.isArray(candidates)
      ? {}
      : {
          analysis_provider_candidates: candidates.map((candidate) => {
            if (!record(candidate)) return candidate;
            const supported = capabilities(candidate.capabilities);
            return supported === undefined
              ? candidate
              : { ...candidate, capabilities: supported };
          }),
        }),
  };
};
