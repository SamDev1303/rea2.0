import { z } from "zod";

import { digestCanonicalValue } from "./canonicalDigest.js";
import { digestSchema } from "./digests.js";
import type { InvestigationWorkflowInput } from "./investigationWorkflowSchemas.js";

const id = z.string().min(1).max(128);
const bindings = z.record(id, digestSchema);
const authority = {
  target_digest: digestSchema,
  authority_id: id,
  session_id: id,
  verification_evidence_digests: bindings,
};
const adjudicationSchema = z
  .object({ ...authority, question_id: id, resolution_digest: digestSchema })
  .strict();
const decisionReceiptSchema = z
  .object({ ...authority, decision_id: id, decision_digest: digestSchema })
  .strict();
export const investigationTrustContextSchema = z
  .object({
    adjudications: z.array(adjudicationSchema).max(1024).default([]),
    decisions: z.array(decisionReceiptSchema).max(1024).default([]),
  })
  .strict();
export type InvestigationTrustContext = z.input<
  typeof investigationTrustContextSchema
>;

/** Compare actual record bytes, not a researcher-controlled label or source digest. */
export const hasBoundInvestigationEvidence = (
  input: InvestigationWorkflowInput,
  references: readonly string[],
  trustedBindings: Readonly<Record<string, string>>,
): boolean =>
  references.length > 0 &&
  references.every((reference) => {
    const entry = input.evidence.find(
      (record) => record.evidence_id === reference,
    );
    return (
      entry !== undefined &&
      trustedBindings[reference] === digestCanonicalValue(entry)
    );
  });

export const hasTrustedInvestigationDecision = (
  input: InvestigationWorkflowInput,
  decisionId: string,
  context: InvestigationTrustContext,
): boolean => {
  const decision = input.prd.decisions.find(
    (entry) => entry.decision_id === decisionId,
  );
  const matches = context.decisions?.filter(
    (receipt) =>
      receipt.decision_id === decisionId &&
      receipt.target_digest === input.target_digest,
  );
  return (
    decision !== undefined &&
    matches?.length === 1 &&
    matches[0]!.decision_digest === digestCanonicalValue(decision) &&
    hasBoundInvestigationEvidence(
      input,
      decision.evidence_ids,
      matches[0]!.verification_evidence_digests,
    )
  );
};

export const hasAcceptedInvestigationResidual = (
  input: InvestigationWorkflowInput,
  kind: "coverage-gap" | "assumption" | "question",
  value: string,
  context: InvestigationTrustContext,
): boolean =>
  input.prd.accepted_residuals.some((residual) => {
    const decision = input.prd.decisions.find(
      (entry) => entry.decision_id === residual.decision_id,
    );
    if (
      residual.kind !== kind ||
      residual.value !== value ||
      decision?.treatment !== "accept-residual" ||
      !hasTrustedInvestigationDecision(input, residual.decision_id, context)
    )
      return false;
    if (kind !== "coverage-gap") return true;
    return (
      residual.capability !== null &&
      input.reports.some((report) =>
        report.capabilities.some(
          (capability) =>
            capability.name === residual.capability &&
            ["unavailable", "untested"].includes(capability.status) &&
            capability.limitation !== null,
        ),
      )
    );
  });
