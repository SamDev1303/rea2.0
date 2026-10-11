import type { Client } from "@modelcontextprotocol/client";
import { expect } from "vitest";
import type { BinarySessionPort } from "../../src/application/binary/BinarySessionPort.js";
import type { AnalysisError } from "../../src/domain/analysisErrorBase.js";
import type { Evidence } from "../../src/domain/evidence.js";
import { createEvidence } from "../../src/domain/evidence.js";
import type { Result } from "../../src/domain/result.js";
import { ok } from "../../src/domain/result.js";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { jsonObjectSchema } from "../../src/domain/jsonValue.js";
import { requireOwnedProducerEvidence } from "./ownedArtifactProducer.js";

/** Retain a real service result from a source-authored fixture; confers no transport authority. */
export const retainOwnedServiceEvidence = async (
  session: BinarySessionPort,
  client: Client,
  result: Result<Evidence, AnalysisError>,
): Promise<Evidence> => {
  const evidence = requireOwnedProducerEvidence(result);
  expect(session.recordEvidence(evidence)).toMatchObject({ ok: true });
  expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
  const retained = await client.callTool({
    name: "get_evidence_bundle",
    arguments: {
      detail: "summary",
      filters: { evidence_id: evidence.evidence_id },
    },
  });
  expect(retained.isError).not.toBe(true);
  expect(retained.structuredContent).toMatchObject({
    result: {
      matching_records: 1,
      records: [
        {
          evidence_id: evidence.evidence_id,
          operation: evidence.operation,
          retention: "complete-record",
        },
      ],
    },
  });
  return evidence;
};

/** Run only an authored tracer fixture or the installed demangler; never a public permission grant. */
export const observeOwnedNativeFixture = async (
  session: BinarySessionPort,
  path: string,
  operation: "observe_native_calls" | "demangle_swift",
  input: Readonly<Record<string, unknown>>,
): Promise<Result<Evidence, AnalysisError>> => {
  if (!["observe_native_calls", "demangle_swift"].includes(operation))
    throw new Error("Operation is outside the owned native test fixture");
  const target = session.activeTarget();
  if (target?.path !== path)
    throw new Error("Native fixture must have its authored target selected");
  const parameters = jsonObjectSchema.parse(
    toolContract(operation).inputSchema.parse(input),
  );
  const executed = await session.execute(operation, parameters);
  if (!executed.ok) return executed;
  const value = executed.value;
  return ok(
    createEvidence(value.subject ?? target, value.provider, {
      operation,
      parameters,
      result: value.result,
      ...(value.analysisProfile === undefined
        ? {}
        : { analysisProfile: value.analysisProfile }),
      rawResult: value.rawResult,
      limitations: value.limitations,
      locations: value.locations,
    }),
  );
};
