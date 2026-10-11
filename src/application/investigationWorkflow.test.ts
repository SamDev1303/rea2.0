import { digestCanonicalValue } from "../domain/canonicalDigest.js";
import { describe, expect, it } from "vitest";

import {
  prepareIndependentBuilderHandoff,
  type ApprovedSpecificationReview,
  type IndependentBuilderReceipt,
} from "./investigationWorkflow.js";
import { reconcileInvestigation } from "../domain/investigationWorkflow.js";
import { investigationWorkflowInputSchema } from "../domain/investigationWorkflowSchemas.js";
import { referenceAcceptsQuantity } from "../../tests/fixtures/investigationWorkflow/referenceQuantity.js";
import {
  quantityInvestigationFixture,
  refreshQuantityReceipts,
} from "../../tests/fixtures/investigationWorkflow/quantitySpecification.js";

const approvedReview = (digest: string): ApprovedSpecificationReview => ({
  specification_digest: digest,
  reviewer_id: "independent-reviewer",
  session_id: "exclusion-review-session",
  verification_evidence_ids: ["exclusion-review"],
  verification_evidence_digests: {
    "exclusion-review": digestCanonicalValue(
      quantityInvestigationFixture().input.evidence.find(
        (entry) => entry.evidence_id === "exclusion-review",
      ),
    ),
  },
  mechanism: "tool-less",
  verdict: "pass",
  reference_implementation_excluded: true,
  credentials_and_private_assets_excluded: true,
});

const builderReceipt = (
  digest: string,
  session = "fresh-builder",
  identity = "fresh-builder-agent",
): IndependentBuilderReceipt => ({
  builder_id: identity,
  session_id: session,
  specification_digest: digest,
  reference_source_access: "none",
  mechanism: "tool-less",
});

describe("investigation to independent specification", () => {
  it("exercises a known defect, two synthetic reports, reviewed specification and acceptance cases", () => {
    const fixture = quantityInvestigationFixture();
    // The target is a trusted synthetic fixture. Only its observed defect enters the report.
    expect(referenceAcceptsQuantity(-1)).toBe(true);
    const report = reconcileInvestigation(fixture.input, fixture.receipts);
    expect(report.status).toBe("ready-for-specification-review");
    const handoff = prepareIndependentBuilderHandoff(
      fixture.input,
      fixture.receipts,
      approvedReview(report.specification_digest),
      builderReceipt(report.specification_digest),
    );
    expect(handoff).not.toHaveProperty("reports");
    expect(handoff).not.toHaveProperty("evidence");
    expect(JSON.stringify(handoff)).not.toContain("synthetic-quantity-app");
    // Fresh implementation consumes the behavioural contract, never the reference function.
    const independentlyAcceptsQuantity = (input: unknown): boolean =>
      typeof input === "number" && Number.isInteger(input) && input >= 1;
    for (const test of fixture.input.prd.acceptance_tests)
      expect(independentlyAcceptsQuantity(test.input), test.test_id).toBe(
        test.expected,
      );
    expect(independentlyAcceptsQuantity(Number.POSITIVE_INFINITY)).toBe(false);
    expect(independentlyAcceptsQuantity("2")).toBe(false);
  });

  it("rejects absent receipts and reused researcher identities", () => {
    const { input, receipts } = quantityInvestigationFixture();
    expect(reconcileInvestigation(input, []).status).toBe("incomplete");
    receipts[1]!.researcher_id = receipts[0]!.researcher_id;
    expect(reconcileInvestigation(input, receipts).blockers).toContain(
      "Researchers are not independent sessions and identities.",
    );
  });

  it("requires further evidence for disagreements and retains unavailable capability limits", () => {
    const { input, receipts } = quantityInvestigationFixture();
    input.reports[1]!.claims[0]!.conclusion = "Negative quantity is rejected.";
    expect(reconcileInvestigation(input, receipts).blockers).toContain(
      "Question quantity-validation: disagreement is unresolved.",
    );
    input.resolutions.push({
      question_id: "quantity-validation",
      conclusion: "Negative quantity is accepted.",
      severity: "high",
      decision_id: "decision-1",
      evidence_ids: ["observation"],
      rationale: "Rechecking the same observation is insufficient.",
    });
    expect(reconcileInvestigation(input, receipts).blockers).toContain(
      "Resolution quantity-validation: further evidence is required.",
    );
    input.evidence.push({
      ...input.evidence[0]!,
      evidence_id: "further-observation",
      locator: "repeat-negative-test",
    });
    input.resolutions[0]!.evidence_ids = ["further-observation"];
    input.reports[0]!.capabilities.push({
      name: "hostile-runtime",
      status: "unavailable",
      evidence_ids: [],
      limitation: "No verified disposable environment exists.",
    });
    const resolution = input.resolutions[0]!;
    input.prd.decisions[0]!.evidence_ids = resolution.evidence_ids;
    input.prd.decisions[0]!.resolution_digest =
      digestCanonicalValue(resolution);
    refreshQuantityReceipts(input, receipts);
    const reconciled = reconcileInvestigation(input, receipts, {
      adjudications: [
        {
          question_id: resolution.question_id,
          resolution_digest: digestCanonicalValue(resolution),
          target_digest: input.target_digest,
          authority_id: "independent-adjudicator",
          session_id: "adjudication-session",
          verification_evidence_digests: Object.fromEntries(
            input.evidence.map((entry) => [
              entry.evidence_id,
              digestCanonicalValue(entry),
            ]),
          ),
        },
      ],
    });
    expect(reconciled.status).toBe("ready-for-specification-review");
    expect(reconciled.input.reports[0]!.capabilities.at(-1)!.status).toBe(
      "unavailable",
    );
  });

  it.each(["unavailable", "untested", "implemented"] as const)(
    "does not promote %s claims to verified",
    (status) => {
      const { input, receipts } = quantityInvestigationFixture();
      input.reports[0]!.claims[0]!.status = status;
      expect(reconcileInvestigation(input, receipts).status).toBe("incomplete");
    },
  );

  it("fails closed on missing evidence, coverage, reciprocal tests and assumptions", () => {
    const { input, receipts } = quantityInvestigationFixture();
    input.evidence = [];
    input.reports[1]!.coverage_gaps.push("Runtime behaviour was not examined.");
    input.prd.acceptance_tests[0]!.requirement_ids = [];
    input.prd.assumptions.push("Input has already been validated.");
    const report = reconcileInvestigation(input, receipts);
    expect(report.status).toBe("incomplete");
    expect(report.blockers).toContain("weaknesses: coverage gaps remain.");
    expect(
      report.blockers.some((item) => item.includes("missing evidence")),
    ).toBe(true);
    expect(report.blockers.some((item) => item.includes("reciprocal"))).toBe(
      true,
    );
  });
});

describe("independent builder boundary", () => {
  it("rejects stale approval, researcher self-review and a reused builder session", () => {
    const { input, receipts } = quantityInvestigationFixture();
    const report = reconcileInvestigation(input, receipts);
    const review = approvedReview(report.specification_digest);
    expect(() =>
      prepareIndependentBuilderHandoff(
        input,
        receipts,
        { ...review, specification_digest: "c".repeat(64) },
        builderReceipt(report.specification_digest),
      ),
    ).toThrow("changed after");
    expect(() =>
      prepareIndependentBuilderHandoff(
        input,
        receipts,
        { ...review, reviewer_id: receipts[0]!.researcher_id },
        builderReceipt(report.specification_digest),
      ),
    ).toThrow("independent");
    expect(() =>
      prepareIndependentBuilderHandoff(
        input,
        receipts,
        review,
        builderReceipt(report.specification_digest, receipts[0]!.session_id),
      ),
    ).toThrow("fresh");
  });

  it("rejects source fields, command fields, over-limit metadata and malformed input", () => {
    const { input } = quantityInvestigationFixture();
    expect(
      investigationWorkflowInputSchema.safeParse({
        ...input,
        source_code: "target implementation",
      }).success,
    ).toBe(false);
    expect(
      investigationWorkflowInputSchema.safeParse({
        ...input,
        prd: { ...input.prd, command: "read credentials" },
      }).success,
    ).toBe(false);
    expect(
      investigationWorkflowInputSchema.safeParse({
        ...input,
        questions: Array.from({ length: 1025 }, () => "q"),
      }).success,
    ).toBe(false);
    expect(investigationWorkflowInputSchema.safeParse(null).success).toBe(
      false,
    );
    expect(
      investigationWorkflowInputSchema.safeParse({
        ...input,
        target_digest: "invalid",
      }).success,
    ).toBe(false);
  });
});
