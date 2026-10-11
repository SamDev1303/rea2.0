import type { BinarySession } from "../../src/application/binary/BinarySession.js";
import type { AnalysisOperation } from "../../src/application/AnalysisProvider.js";
import { createArtifactExtractionDestination } from "../../src/application/artifacts/ArtifactExtractionDestination.js";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { artifactInspectionResultSchema } from "../../src/domain/artifactInspection.js";
import { createEvidence } from "../../src/domain/evidence.js";
import { jsonObjectSchema } from "../../src/domain/jsonValue.js";
import { ok } from "../../src/domain/result.js";
import type { Result } from "../../src/domain/result.js";
import type { Evidence } from "../../src/domain/evidence.js";
import type { AnalysisError } from "../../src/domain/analysisErrorBase.js";
import { projectAnalysisError } from "../../src/domain/analysisErrorProjection.js";
import type { Client } from "@modelcontextprotocol/client";
import { expect } from "vitest";
import { parseMcpToolError } from "./mcpToolError.js";

type ProducerOperation = Extract<
  AnalysisOperation,
  | "inspect_artifact"
  | "extract_artifact"
  | "inspect_managed_artifact"
  | "inspect_managed_members"
  | "inspect_managed_native_boundaries"
>;

/** Direct source-authored fixture execution; never a successful public MCP receipt or a host permission grant. */
export const createOwnedArtifactProducer = (
  session: BinarySession,
  sourceAuthoredPaths: readonly string[],
) => {
  const paths = new Set(sourceAuthoredPaths);
  const operations = new Set<ProducerOperation>([
    "inspect_artifact",
    "extract_artifact",
    "inspect_managed_artifact",
    "inspect_managed_members",
    "inspect_managed_native_boundaries",
  ]);
  let selectedTarget:
    | { readonly path: string; readonly sha256: string }
    | undefined;
  const open = async (path: string) => {
    if (!paths.has(path))
      throw new Error("Path is not an authored fixture of this producer");
    const opened = await session.open(path);
    if (opened.ok)
      selectedTarget = { path: opened.value.path, sha256: opened.value.sha256 };
    return opened;
  };
  const produce = async (
    operation: ProducerOperation,
    rawInput: Readonly<Record<string, unknown>> = {},
  ) => {
    if (!operations.has(operation))
      throw new Error("Operation is outside this authored fixture producer");
    const parameters = jsonObjectSchema.parse(
      toolContract(operation).inputSchema.parse(rawInput),
    );
    const requestedPath = parameters.path;
    if (typeof requestedPath === "string") {
      const opened = await open(requestedPath);
      if (!opened.ok) return opened;
    }
    const target = session.activeTarget();
    if (
      target === undefined ||
      selectedTarget === undefined ||
      target.sha256 !== selectedTarget.sha256 ||
      target.path !== selectedTarget.path
    )
      throw new Error(
        "Direct fixture producer has no controller-selected target",
      );
    const execution = await session.execute(
      operation,
      operation === "extract_artifact"
        ? { ...parameters, output_root: createArtifactExtractionDestination() }
        : parameters,
    );
    if (!execution.ok) return execution;
    const sourceEvidence =
      operation === "inspect_artifact"
        ? artifactInspectionResultSchema
            .parse(execution.value.result)
            .substeps.map(({ evidence }) => evidence)
        : [];
    const evidence = createEvidence(
      execution.value.subject ?? target,
      execution.value.provider,
      {
        operation,
        parameters,
        result: execution.value.result,
        ...(execution.value.analysisProfile === undefined
          ? {}
          : { analysisProfile: execution.value.analysisProfile }),
        rawResult: execution.value.rawResult,
        limitations: execution.value.limitations,
        locations: execution.value.locations,
        evidenceLinks: sourceEvidence.map(({ evidence_id }) => evidence_id),
      },
    );
    for (const record of [...sourceEvidence, evidence]) {
      const retained = session.recordEvidence(record);
      if (!retained.ok) return retained;
    }
    return ok(evidence);
  };
  return { open, produce };
};

export const requireOwnedProducerEvidence = (
  result: Result<Evidence, AnalysisError>,
): Evidence => {
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
};

/** Domain error projection from the real direct producer, not a transport response. */
export const projectOwnedProducerError = (
  result: Result<Evidence, AnalysisError>,
) => {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Fixture producer unexpectedly succeeded");
  return { error: projectAnalysisError(result.error) };
};

export const assertOwnedFixturePublicDenial = async (
  client: Client,
  name: string,
  input: Readonly<Record<string, unknown>>,
): Promise<void> => {
  const denied = await client.callTool({ name, arguments: input });
  expect(denied.isError).toBe(true);
  expect(parseMcpToolError(denied)).toMatchObject({
    error: {
      code: "capability_unavailable",
      details: { provider_id: "rea2-protected-host", operation: name },
    },
  });
};
