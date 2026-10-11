import { describe, expect, it } from "vitest";

import { digestCanonicalValue } from "../domain/canonicalDigest.js";
import { reconcileInvestigation } from "../domain/investigationWorkflow.js";
import type { InvestigationTrustContext } from "../domain/investigationWorkflowTrust.js";
import {
  prepareIndependentBuilderHandoff,
  type ApprovedSpecificationReview,
  type IndependentBuilderReceipt,
} from "./investigationWorkflow.js";
import {
  quantityInvestigationFixture,
  refreshQuantityReceipts,
} from "../../tests/fixtures/investigationWorkflow/quantitySpecification.js";

const reviewAndBuilder = () => {
  const fixture = quantityInvestigationFixture();
  const digest = reconcileInvestigation(
    fixture.input,
    fixture.receipts,
  ).specification_digest;
  const review: ApprovedSpecificationReview = {
    specification_digest: digest,
    reviewer_id: "reviewer",
    session_id: "review-session",
    verification_evidence_ids: ["exclusion-review"],
    verification_evidence_digests: {
      "exclusion-review": digestCanonicalValue(
        fixture.input.evidence.find(
          (entry) => entry.evidence_id === "exclusion-review",
        ),
      ),
    },
    mechanism: "tool-less",
    verdict: "pass",
    reference_implementation_excluded: true,
    credentials_and_private_assets_excluded: true,
  };
  const builder: IndependentBuilderReceipt = {
    builder_id: "builder",
    session_id: "fresh-session",
    specification_digest: digest,
    reference_source_access: "none",
    mechanism: "tool-less",
  };
  return { ...fixture, review, builder };
};

const decisionContext = (
  fixture: ReturnType<typeof quantityInvestigationFixture>,
): InvestigationTrustContext => ({
  decisions: [
    {
      decision_id: fixture.input.prd.decisions[0]!.decision_id,
      decision_digest: digestCanonicalValue(fixture.input.prd.decisions[0]),
      target_digest: fixture.input.target_digest,
      authority_id: "product-owner",
      session_id: "decision-record",
      verification_evidence_digests: Object.fromEntries(
        fixture.input.evidence.map((entry) => [
          entry.evidence_id,
          digestCanonicalValue(entry),
        ]),
      ),
    },
  ],
});

describe("trusted investigation byte and coverage commitments", () => {
  it("blocks replacement of report conclusions under an otherwise valid launch receipt", () => {
    const { input, receipts } = quantityInvestigationFixture();
    input.reports.forEach((report) => {
      report.claims[0]!.conclusion = "A forged matching conclusion.";
    });
    expect(reconcileInvestigation(input, receipts).blockers).toContain(
      "architecture: trusted report digest mismatch.",
    );
  });

  it.each(["observation", "readonly-a"])(
    "blocks evidence-byte substitution under unchanged identifier %s",
    (id) => {
      const { input, receipts } = quantityInvestigationFixture();
      input.evidence.find((entry) => entry.evidence_id === id)!.locator =
        "forged bytes under a legitimate id";
      expect(reconcileInvestigation(input, receipts).blockers).toContain(
        "architecture: trusted evidence digest mismatch.",
      );
    },
  );

  it("blocks severe findings omitted from tested requirements and untrusted omission decisions", () => {
    const fixture = quantityInvestigationFixture();
    fixture.input.prd.requirements[0]!.prevents_finding_ids = [];
    expect(
      reconcileInvestigation(fixture.input, fixture.receipts).blockers.some(
        (blocker) => blocker.includes("severe weakness"),
      ),
    ).toBe(true);
    const decision = fixture.input.prd.decisions[0]!;
    decision.treatment = "omit";
    decision.finding_ids = ["finding-0", "finding-1"];
    expect(reconcileInvestigation(fixture.input, fixture.receipts).status).toBe(
      "incomplete",
    );
    const context = decisionContext(fixture);
    expect(
      reconcileInvestigation(fixture.input, fixture.receipts, context).status,
    ).toBe("ready-for-specification-review");
    decision.rationale = "Changed after approved omission.";
    expect(
      reconcileInvestigation(fixture.input, fixture.receipts, context).status,
    ).toBe("incomplete");
  });

  it("accepts residual assumptions or scoped unavailable coverage only through bound owner decisions", () => {
    const fixture = quantityInvestigationFixture();
    const assumption = "Performance must be rechecked on the deployment host.";
    fixture.input.prd.assumptions = [assumption];
    const decision = fixture.input.prd.decisions[0]!;
    decision.treatment = "accept-residual";
    fixture.input.prd.accepted_residuals = [
      {
        kind: "assumption",
        value: assumption,
        decision_id: decision.decision_id,
        capability: null,
      },
    ];
    expect(reconcileInvestigation(fixture.input, fixture.receipts).status).toBe(
      "incomplete",
    );
    expect(
      reconcileInvestigation(
        fixture.input,
        fixture.receipts,
        decisionContext(fixture),
      ).status,
    ).toBe("ready-for-specification-review");
    fixture.input.reports[0]!.coverage_gaps = ["Hostile runtime unavailable."];
    fixture.input.reports[0]!.capabilities.push({
      name: "hostile-runtime",
      status: "unavailable",
      limitation: "No verified isolated runner.",
      evidence_ids: [],
    });
    fixture.input.prd.accepted_residuals.push({
      kind: "coverage-gap",
      value: "Hostile runtime unavailable.",
      capability: "hostile-runtime",
      decision_id: decision.decision_id,
    });
    refreshQuantityReceipts(fixture.input, fixture.receipts);
    expect(
      reconcileInvestigation(
        fixture.input,
        fixture.receipts,
        decisionContext(fixture),
      ).status,
    ).toBe("ready-for-specification-review");
    fixture.input.prd.accepted_residuals.at(-1)!.capability = "unrecognised";
    expect(
      reconcileInvestigation(
        fixture.input,
        fixture.receipts,
        decisionContext(fixture),
      ).status,
    ).toBe("incomplete");
  });

  it("does not resolve a severity disagreement using planted untrusted evidence", () => {
    const fixture = quantityInvestigationFixture();
    fixture.input.reports[1]!.claims[0]!.severity = "critical";
    refreshQuantityReceipts(fixture.input, fixture.receipts);
    fixture.input.resolutions = [
      {
        question_id: "quantity-validation",
        conclusion: fixture.input.reports[0]!.claims[0]!.conclusion,
        severity: "critical",
        decision_id: "decision-1",
        evidence_ids: ["exclusion-review"],
        rationale: "A caller has planted this record.",
      },
    ];
    expect(
      reconcileInvestigation(fixture.input, fixture.receipts).blockers,
    ).toContain(
      "Resolution quantity-validation: trusted adjudication or bound evidence is missing.",
    );
  });
});

describe("fresh independent builder commitments", () => {
  it("rejects researcher or reviewer reuse under a new builder session", () => {
    const { input, receipts, review, builder } = reviewAndBuilder();
    for (const identity of [
      receipts[0]!.researcher_id,
      receipts[1]!.researcher_id,
      review.reviewer_id,
    ]) {
      expect(() =>
        prepareIndependentBuilderHandoff(input, receipts, review, {
          ...builder,
          builder_id: identity,
        }),
      ).toThrow("fresh independent identity");
    }
  });

  it("rejects changed specification review evidence under the same id", () => {
    const { input, receipts, review, builder } = reviewAndBuilder();
    input.evidence.find(
      (entry) => entry.evidence_id === "exclusion-review",
    )!.locator = "counterfeit review";
    expect(() =>
      prepareIndependentBuilderHandoff(input, receipts, review, builder),
    ).toThrow("trusted digest differs");
  });

  it("keeps test fixture payloads and reference findings out of handoff while transferring decisions", () => {
    const { input, receipts, review, builder } = reviewAndBuilder();
    input.prd.acceptance_tests[0]!.input = {
      source: "A fixture payload must not travel to the builder.",
    };
    const digest = reconcileInvestigation(input, receipts).specification_digest;
    const handoff = prepareIndependentBuilderHandoff(
      input,
      receipts,
      { ...review, specification_digest: digest },
      { ...builder, specification_digest: digest },
    );
    expect(handoff.acceptance_tests[0]).not.toHaveProperty("input");
    expect(handoff.acceptance_tests[0]).not.toHaveProperty("expected");
    expect(handoff).not.toHaveProperty("prioritised_findings");
    expect(handoff.decisions[0]!.statement).toBe(
      input.prd.decisions[0]!.rationale,
    );
  });
});
