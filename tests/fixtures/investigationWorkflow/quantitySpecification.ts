import { digestCanonicalValue } from "../../../src/domain/canonicalDigest.js";
import type {
  InvestigationRunReceipt,
  InvestigationWorkflowInput,
} from "../../../src/domain/investigationWorkflowSchemas.js";

/** Synthetic reports: runtime evidence is fixture data, not a claim of live agents. */
export const quantityInvestigationFixture = (): {
  input: InvestigationWorkflowInput;
  receipts: InvestigationRunReceipt[];
} => {
  const targetDigest = "a".repeat(64);
  const evidence = [
    "readonly-a",
    "readonly-b",
    "observation",
    "exclusion-review",
  ].map((id) => ({
    evidence_id: id,
    target_digest: targetDigest,
    source: "synthetic-quantity-app",
    source_digest: "b".repeat(64),
    locator: id,
    confidence: "observed" as const,
    limitations: ["Synthetic fixture; not a real research session."],
  }));
  const section = [
    {
      statement:
        "Quantity must be a finite positive integer; invalid quantity returns an error without modifying state.",
      evidence_ids: ["observation"],
      decision_id: "decision-1",
    },
  ];
  const fixture: {
    input: InvestigationWorkflowInput;
    receipts: InvestigationRunReceipt[];
  } = {
    receipts: (["architecture", "weaknesses"] as const).map((role, index) => ({
      session_id: `session-${index}`,
      researcher_id: `researcher-${index}`,
      role,
      target_digest: targetDigest,
      mechanism: "tool-less",
      report_digest: "c".repeat(64),
      verification_evidence_digests: {},
      verification_evidence_ids: [`readonly-${index === 0 ? "a" : "b"}`],
      can_write: false,
      can_push: false,
      can_read_credentials: false,
    })),
    input: {
      target_digest: targetDigest,
      questions: ["quantity-validation"],
      evidence,
      reports: (["architecture", "weaknesses"] as const).map((role, index) => ({
        session_id: `session-${index}`,
        role,
        target_digest: targetDigest,
        examined_surfaces: ["synthetic quantity behaviour"],
        coverage_gaps: [],
        claims: [
          {
            claim_id: `finding-${index}`,
            question_id: "quantity-validation",
            conclusion:
              "Negative quantity is accepted by the reference and must be rejected in the new product.",
            evidence_ids: ["observation"],
            status: "verified",
            finding_kind: "bug",
            severity: "high",
            reproducible: true,
            reproduction:
              "Submit -1 to the synthetic quantity interface; reference accepts it.",
          },
        ],
        capabilities: [
          {
            name: "synthetic-replay",
            status: "verified",
            evidence_ids: ["observation"],
            limitation: null,
          },
        ],
      })),
      resolutions: [],
      prd: {
        product_name: "Quantity Guard",
        users_and_problems: section,
        value_and_differentiation: section,
        journeys_state_errors_and_edges: section,
        interfaces_data_and_integrations: section,
        security_privacy_and_reliability: section,
        accessibility_and_performance: section,
        dependencies_and_rollout: section,
        decisions: [
          {
            decision_id: "decision-1",
            rationale: "Prevent the evidenced negative quantity defect.",
            treatment: "address",
            finding_ids: [],
            evidence_ids: ["observation"],
            resolution_digest: null,
          },
        ],
        requirements: [
          {
            requirement_id: "quantity-1",
            behaviour:
              "Accept finite positive integers; reject all other quantities without modifying state.",
            priority: "mvp",
            treatment: "improve",
            evidence_ids: ["observation"],
            decision_id: "decision-1",
            acceptance_test_ids: ["positive", "negative", "fraction", "zero"],
            prevents_finding_ids: ["finding-0", "finding-1"],
          },
        ],
        acceptance_tests: [
          ["positive", 2, true],
          ["negative", -1, false],
          ["fraction", 1.5, false],
          ["zero", 0, false],
        ].map(([testId, input, expected]) => ({
          test_id: String(testId),
          requirement_ids: ["quantity-1"],
          given: "An unchanged quantity state",
          when: "A quantity is submitted",
          expected_behaviour: "Return whether the submitted quantity is valid",
          input: Number(input),
          expected: Boolean(expected),
        })),
        accepted_residuals: [],
        assumptions: [],
        unresolved_questions: [],
      },
    },
  };
  refreshQuantityReceipts(fixture.input, fixture.receipts);
  return fixture;
};

/** Test-only fixture authority: never issue trusted production receipts from caller JSON. */
export const refreshQuantityReceipts = (
  input: InvestigationWorkflowInput,
  receipts: InvestigationRunReceipt[],
): void => {
  for (const receipt of receipts) {
    const report = input.reports.find(
      (entry) =>
        entry.role === receipt.role && entry.session_id === receipt.session_id,
    );
    if (report === undefined)
      throw new Error("Fixture run does not match report.");
    receipt.report_digest = digestCanonicalValue({
      report,
      questions: input.questions,
    });
    receipt.verification_evidence_digests = Object.fromEntries(
      input.evidence.map((entry) => [
        entry.evidence_id,
        digestCanonicalValue(entry),
      ]),
    );
  }
};
