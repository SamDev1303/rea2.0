import {
  hasAcceptedInvestigationResidual,
  hasBoundInvestigationEvidence,
  hasTrustedInvestigationDecision,
  investigationTrustContextSchema,
  type InvestigationTrustContext,
} from "./investigationWorkflowTrust.js";
import { assertInvestigationWorkflowBudget } from "./investigationWorkflowBudget.js";
import { digestCanonicalValue } from "./canonicalDigest.js";
import {
  investigationRunReceiptSchema,
  investigationWorkflowInputSchema,
  type InvestigationRunReceipt,
  type InvestigationWorkflowInput,
} from "./investigationWorkflowSchemas.js";

export interface InvestigationWorkflowReport {
  readonly schema: "InvestigationWorkflowReport";
  readonly specification_digest: string;
  readonly target_digest: string;
  readonly status: "ready-for-specification-review" | "incomplete";
  readonly blockers: readonly string[];
  readonly evidence_links: readonly string[];
  readonly prioritised_findings: readonly InvestigationWorkflowInput["reports"][number]["claims"][number][];
  readonly input: InvestigationWorkflowInput;
  readonly limitations: readonly string[];
}

/** Reconcile researcher reports against receipts supplied by the enforcing launcher. */
export const reconcileInvestigation = (
  inputValue: unknown,
  trustedRunReceipts: readonly InvestigationRunReceipt[],
  trustedContextValue: InvestigationTrustContext = {},
): InvestigationWorkflowReport => {
  assertInvestigationWorkflowBudget(inputValue);
  const input = investigationWorkflowInputSchema.parse(inputValue);
  const receipts = trustedRunReceipts.map((receipt) =>
    investigationRunReceiptSchema.parse(receipt),
  );
  const trustedContext =
    investigationTrustContextSchema.parse(trustedContextValue);
  const blockers: string[] = [];
  const evidence = new Map(
    input.evidence.map((entry) => [entry.evidence_id, entry]),
  );
  if (evidence.size !== input.evidence.length)
    blockers.push("Duplicate evidence identifiers.");
  if (
    input.evidence.some((entry) => entry.target_digest !== input.target_digest)
  )
    blockers.push("Evidence target does not match investigation target.");
  const requireEvidence = (
    references: readonly string[],
    context: string,
  ): void => {
    if (
      references.length === 0 ||
      references.some((reference) => !evidence.has(reference))
    )
      blockers.push(`${context}: missing evidence.`);
  };
  validateResearchers({
    input,
    receipts,
    requireEvidence,
    blockers,
    trustedContext,
  });
  validateReconciliation({ input, requireEvidence, blockers, trustedContext });
  validatePrd(input, requireEvidence, blockers);
  validateProductCoverage(input, trustedContext, blockers);
  return {
    schema: "InvestigationWorkflowReport",
    specification_digest: digestCanonicalValue(input.prd),
    target_digest: input.target_digest,
    status:
      blockers.length === 0 ? "ready-for-specification-review" : "incomplete",
    blockers: [...new Set(blockers)].sort(),
    evidence_links: [...evidence.keys()].sort(),
    prioritised_findings: input.reports
      .flatMap((report) => report.claims)
      .sort(
        (left, right) =>
          severityRank(right.severity) - severityRank(left.severity) ||
          left.claim_id.localeCompare(right.claim_id),
      ),
    input,
    limitations: [
      "Coverage describes the declared investigation questions; it is not exhaustive vulnerability or feature discovery.",
      "Read-only enforcement is established by the trusted launch boundary, not researcher self-attestation.",
      "Builder handoff excludes reference fields structurally; approved specification text still requires independent review for copied implementation or assets.",
      "Unavailable capabilities remain unavailable and are not evidence of examined runtime behaviour.",
    ],
  };
};

type RequireEvidence = (references: readonly string[], context: string) => void;

interface WorkflowValidation {
  readonly input: InvestigationWorkflowInput;
  readonly requireEvidence: RequireEvidence;
  readonly blockers: string[];
  readonly trustedContext: InvestigationTrustContext;
}
const validateResearchers = ({
  input,
  receipts,
  requireEvidence,
  blockers,
  trustedContext,
}: WorkflowValidation & {
  readonly receipts: readonly InvestigationRunReceipt[];
}): void => {
  const matchedRuns: InvestigationRunReceipt[] = [];
  const claimIds = input.reports.flatMap((report) =>
    report.claims.map((claim) => claim.claim_id),
  );
  if (new Set(claimIds).size !== claimIds.length)
    blockers.push("Duplicate claim identifiers.");
  if (new Set(input.questions).size !== input.questions.length)
    blockers.push("Duplicate declared questions.");
  for (const role of ["architecture", "weaknesses"] as const) {
    const reports = input.reports.filter((report) => report.role === role);
    if (reports.length !== 1) {
      blockers.push(`Exactly one ${role} researcher report is required.`);
      continue;
    }
    const report = reports[0]!;
    const matching = receipts.filter(
      (receipt) =>
        receipt.session_id === report.session_id &&
        receipt.role === role &&
        receipt.target_digest === input.target_digest,
    );
    if (matching.length !== 1 || report.target_digest !== input.target_digest)
      blockers.push(
        `${role}: no unique trusted read-only run receipt for this target.`,
      );
    else {
      const receipt = matching[0]!;
      requireEvidence(
        receipt.verification_evidence_ids,
        `${role} read-only verification`,
      );
      if (
        receipt.report_digest !==
        digestCanonicalValue({ report, questions: input.questions })
      )
        blockers.push(`${role}: trusted report digest mismatch.`);
      const references = [
        ...receipt.verification_evidence_ids,
        ...report.claims.flatMap((claim) => claim.evidence_ids),
        ...report.capabilities.flatMap((capability) => capability.evidence_ids),
      ];
      if (
        !hasBoundInvestigationEvidence(
          input,
          references,
          receipt.verification_evidence_digests,
        )
      )
        blockers.push(`${role}: trusted evidence digest mismatch.`);
      matchedRuns.push(receipt);
    }
    validateResearchContents({
      input,
      report,
      requireEvidence,
      blockers,
      trustedContext,
    });
  }
  if (
    matchedRuns.length === 2 &&
    (matchedRuns[0]!.researcher_id === matchedRuns[1]!.researcher_id ||
      matchedRuns[0]!.session_id === matchedRuns[1]!.session_id)
  )
    blockers.push("Researchers are not independent sessions and identities.");
};

const validateResearchContents = ({
  input,
  report,
  requireEvidence,
  blockers,
  trustedContext,
}: WorkflowValidation & {
  readonly report: InvestigationWorkflowInput["reports"][number];
}): void => {
  if (
    report.coverage_gaps.some(
      (gap) =>
        !hasAcceptedInvestigationResidual(
          input,
          "coverage-gap",
          gap,
          trustedContext,
        ),
    )
  )
    blockers.push(`${report.role}: coverage gaps remain.`);
  for (const claim of report.claims) {
    requireEvidence(claim.evidence_ids, `Claim ${claim.claim_id}`);
    if (claim.status !== "verified")
      blockers.push(`Claim ${claim.claim_id}: ${claim.status}.`);
    if (!claim.reproducible || claim.reproduction === null)
      blockers.push(`Claim ${claim.claim_id}: reproduction is missing.`);
    if (!input.questions.includes(claim.question_id))
      blockers.push(
        `Claim ${claim.claim_id}: question is outside declared scope.`,
      );
  }
  for (const capability of report.capabilities) {
    if (capability.status === "verified")
      requireEvidence(capability.evidence_ids, `Capability ${capability.name}`);
    else if (capability.limitation === null)
      blockers.push(`Capability ${capability.name}: limitation is missing.`);
  }
};

const validateReconciliation = ({
  input,
  requireEvidence,
  blockers,
  trustedContext,
}: WorkflowValidation): void => {
  for (const question of input.questions) {
    const claims = input.reports.map((report) =>
      report.claims.filter((claim) => claim.question_id === question),
    );
    if (claims.length !== 2 || claims.some((entries) => entries.length === 0)) {
      blockers.push(`Question ${question}: both researchers must examine it.`);
      continue;
    }
    const conclusions = new Set(
      claims
        .flat()
        .map((claim) => `${claim.conclusion} severity:${claim.severity}`),
    );
    if (conclusions.size > 1) {
      const resolutions = input.resolutions.filter(
        (entry) => entry.question_id === question,
      );
      if (resolutions.length !== 1)
        blockers.push(`Question ${question}: disagreement is unresolved.`);
      else {
        const resolution = resolutions[0]!;
        requireEvidence(resolution.evidence_ids, `Resolution ${question}`);
        const receipts = trustedContext.adjudications?.filter(
          (receipt) =>
            receipt.question_id === question &&
            receipt.target_digest === input.target_digest,
        );
        if (
          receipts?.length !== 1 ||
          receipts[0]!.resolution_digest !== digestCanonicalValue(resolution) ||
          !hasBoundInvestigationEvidence(
            input,
            resolution.evidence_ids,
            receipts[0]!.verification_evidence_digests,
          )
        )
          blockers.push(
            `Resolution ${question}: trusted adjudication or bound evidence is missing.`,
          );
        const decision = input.prd.decisions.find(
          (entry) => entry.decision_id === resolution.decision_id,
        );
        if (
          decision === undefined ||
          !resolution.evidence_ids.every((id) =>
            decision.evidence_ids.includes(id),
          ) ||
          decision.resolution_digest !== digestCanonicalValue(resolution)
        )
          blockers.push(
            `Resolution ${question}: PRD must record the adjudicated conclusion, severity and evidence.`,
          );
        const original = new Set(
          claims.flat().flatMap((claim) => claim.evidence_ids),
        );
        if (
          !resolution.evidence_ids.some((reference) => !original.has(reference))
        )
          blockers.push(
            `Resolution ${question}: further evidence is required.`,
          );
      }
    }
  }
};

const validatePrd = (
  input: InvestigationWorkflowInput,
  requireEvidence: (references: readonly string[], context: string) => void,
  blockers: string[],
): void => {
  const prd = input.prd;
  const decisions = new Set(
    prd.decisions.map((decision) => decision.decision_id),
  );
  const requirements = new Set(
    prd.requirements.map((requirement) => requirement.requirement_id),
  );
  const tests = new Set(prd.acceptance_tests.map((test) => test.test_id));
  const claims = new Set(
    input.reports.flatMap((report) =>
      report.claims.map((claim) => claim.claim_id),
    ),
  );
  if (
    decisions.size !== prd.decisions.length ||
    requirements.size !== prd.requirements.length ||
    tests.size !== prd.acceptance_tests.length
  )
    blockers.push(
      "PRD contains duplicate decision, requirement, or test identifiers.",
    );
  for (const section of [
    prd.users_and_problems,
    prd.value_and_differentiation,
    prd.journeys_state_errors_and_edges,
    prd.interfaces_data_and_integrations,
    prd.security_privacy_and_reliability,
    prd.accessibility_and_performance,
    prd.dependencies_and_rollout,
  ].flat()) {
    requireEvidence(section.evidence_ids, "PRD section");
    if (!decisions.has(section.decision_id))
      blockers.push("PRD section has no product decision.");
  }
  for (const requirement of prd.requirements) {
    requireEvidence(
      requirement.evidence_ids,
      `Requirement ${requirement.requirement_id}`,
    );
    if (!decisions.has(requirement.decision_id))
      blockers.push(
        `Requirement ${requirement.requirement_id}: product decision is missing.`,
      );
    if (
      requirement.priority !== "omit" &&
      (requirement.acceptance_test_ids.length === 0 ||
        requirement.acceptance_test_ids.some((id) => !tests.has(id)))
    )
      blockers.push(
        `Requirement ${requirement.requirement_id}: acceptance tests are missing.`,
      );
    if (requirement.prevents_finding_ids.some((id) => !claims.has(id)))
      blockers.push(
        `Requirement ${requirement.requirement_id}: referenced finding is missing.`,
      );
    for (const testId of requirement.acceptance_test_ids) {
      if (
        !prd.acceptance_tests
          .find((test) => test.test_id === testId)
          ?.requirement_ids.includes(requirement.requirement_id)
      )
        blockers.push(
          `Requirement ${requirement.requirement_id}: test traceability is not reciprocal.`,
        );
    }
  }
  for (const test of prd.acceptance_tests) {
    if (
      test.requirement_ids.length === 0 ||
      test.requirement_ids.some((id) => !requirements.has(id))
    )
      blockers.push(`Test ${test.test_id}: requirement is missing.`);
  }
};

const severityRank = (severity: string): number =>
  ["info", "low", "medium", "high", "critical"].indexOf(severity);

const validateProductCoverage = (
  input: InvestigationWorkflowInput,
  context: InvestigationTrustContext,
  blockers: string[],
): void => {
  for (const claim of input.reports.flatMap((report) => report.claims)) {
    if (
      claim.status !== "verified" ||
      !["high", "critical"].includes(claim.severity)
    )
      continue;
    const addressed = input.prd.requirements.some(
      (requirement) =>
        requirement.prevents_finding_ids.includes(claim.claim_id) &&
        requirement.priority !== "omit" &&
        requirement.treatment !== "omit" &&
        requirement.acceptance_test_ids.length > 0,
    );
    const omitted = input.prd.decisions.some(
      (decision) =>
        decision.treatment === "omit" &&
        decision.finding_ids.includes(claim.claim_id) &&
        hasTrustedInvestigationDecision(input, decision.decision_id, context),
    );
    if (!addressed && !omitted)
      blockers.push(
        `Finding ${claim.claim_id}: severe weakness has no tested requirement or trusted omission decision.`,
      );
  }
  if (
    input.prd.assumptions.some(
      (value) =>
        !hasAcceptedInvestigationResidual(input, "assumption", value, context),
    ) ||
    input.prd.unresolved_questions.some(
      (value) =>
        !hasAcceptedInvestigationResidual(input, "question", value, context),
    )
  )
    blockers.push(
      "PRD assumptions or unresolved questions require a trusted accepted product decision.",
    );
};
