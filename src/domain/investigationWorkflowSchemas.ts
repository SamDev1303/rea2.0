import { z } from "zod";

import { digestSchema } from "./digests.js";
import { jsonValueSchema } from "./jsonValue.js";

const text = z.string().min(1).max(8192);
const id = z.string().min(1).max(128);
const ids = z.array(id).max(1024);
const role = z.enum(["architecture", "weaknesses"]);
const status = z.enum(["implemented", "verified", "unavailable", "untested"]);

/** These receipts belong to the enforcing launcher, never the researcher report. */
export const investigationRunReceiptSchema = z
  .object({
    session_id: id,
    researcher_id: id,
    role,
    target_digest: digestSchema,
    mechanism: z.enum(["read-only-sandbox", "tool-less"]),
    verification_evidence_ids: ids,
    report_digest: digestSchema,
    verification_evidence_digests: z.record(id, digestSchema),
    can_write: z.literal(false),
    can_push: z.literal(false),
    can_read_credentials: z.literal(false),
  })
  .strict();

export const investigationEvidenceSchema = z
  .object({
    evidence_id: id,
    target_digest: digestSchema,
    source: text,
    source_digest: digestSchema,
    locator: text,
    confidence: z.enum(["observed", "derived", "inferred"]),
    limitations: z.array(text).max(128),
  })
  .strict();

const claimSchema = z
  .object({
    claim_id: id,
    question_id: id,
    conclusion: text,
    evidence_ids: ids,
    status,
    finding_kind: z.enum([
      "behaviour",
      "bug",
      "vulnerability",
      "failure",
      "improvement",
    ]),
    severity: z.enum(["info", "low", "medium", "high", "critical"]),
    reproducible: z.boolean(),
    reproduction: text.nullable(),
  })
  .strict();

export const investigationResearchReportSchema = z
  .object({
    session_id: id,
    role,
    target_digest: digestSchema,
    examined_surfaces: z.array(text).min(1).max(1024),
    coverage_gaps: z.array(text).max(1024),
    claims: z.array(claimSchema).max(1024),
    capabilities: z
      .array(
        z
          .object({
            name: id,
            status,
            evidence_ids: ids,
            limitation: text.nullable(),
          })
          .strict(),
      )
      .max(128),
  })
  .strict();

const requirementSchema = z
  .object({
    requirement_id: id,
    behaviour: text,
    priority: z.enum(["mvp", "later", "omit"]),
    treatment: z.enum(["preserve", "improve", "new", "omit"]),
    evidence_ids: ids,
    decision_id: id,
    acceptance_test_ids: ids,
    prevents_finding_ids: ids,
  })
  .strict();

const acceptanceSchema = z
  .object({
    test_id: id,
    requirement_ids: ids,
    given: text,
    when: text,
    expected_behaviour: text,
    input: jsonValueSchema,
    expected: jsonValueSchema,
  })
  .strict();

const sectionSchema = z
  .object({
    statement: text,
    evidence_ids: ids,
    decision_id: id,
  })
  .strict();
const sections = z.array(sectionSchema).min(1).max(128);

/** Behavioural specification only: no source, binary, assets, or implementation field. */
export const investigationPrdSchema = z
  .object({
    product_name: text,
    users_and_problems: sections,
    value_and_differentiation: sections,
    journeys_state_errors_and_edges: sections,
    interfaces_data_and_integrations: sections,
    security_privacy_and_reliability: sections,
    accessibility_and_performance: sections,
    dependencies_and_rollout: sections,
    decisions: z
      .array(
        z
          .object({
            decision_id: id,
            rationale: text,
            treatment: z.enum(["address", "omit", "accept-residual"]),
            finding_ids: ids,
            evidence_ids: ids,
            resolution_digest: digestSchema.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(1024),
    requirements: z.array(requirementSchema).min(1).max(1024),
    acceptance_tests: z.array(acceptanceSchema).min(1).max(1024),
    accepted_residuals: z
      .array(
        z
          .object({
            kind: z.enum(["coverage-gap", "assumption", "question"]),
            value: text,
            decision_id: id,
            capability: id.nullable(),
          })
          .strict(),
      )
      .max(1024),
    assumptions: z.array(text).max(1024),
    unresolved_questions: z.array(text).max(1024),
  })
  .strict();

export const investigationWorkflowInputSchema = z
  .object({
    target_digest: digestSchema,
    questions: z.array(id).min(1).max(1024),
    evidence: z.array(investigationEvidenceSchema).max(4096),
    reports: z.array(investigationResearchReportSchema).max(2),
    resolutions: z
      .array(
        z
          .object({
            question_id: id,
            conclusion: text,
            severity: z.enum(["info", "low", "medium", "high", "critical"]),
            decision_id: id,
            evidence_ids: ids,
            rationale: text,
          })
          .strict(),
      )
      .max(1024),
    prd: investigationPrdSchema,
  })
  .strict();

export type InvestigationRunReceipt = z.infer<
  typeof investigationRunReceiptSchema
>;
export type InvestigationWorkflowInput = z.infer<
  typeof investigationWorkflowInputSchema
>;

/** Public reconciliation output retains uncertainty and never asserts completion. */
export const investigationWorkflowReportSchema = z
  .object({
    schema: z.literal("InvestigationWorkflowReport"),
    specification_digest: digestSchema,
    target_digest: digestSchema,
    status: z.enum(["ready-for-specification-review", "incomplete"]),
    blockers: z.array(text),
    evidence_links: ids,
    prioritised_findings: z.array(claimSchema).max(2048),
    input: investigationWorkflowInputSchema,
    limitations: z.array(text),
  })
  .strict();
