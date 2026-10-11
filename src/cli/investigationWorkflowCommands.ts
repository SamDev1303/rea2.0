import { z } from "incur";
import type { Logger } from "pino";

import { readInvestigationWorkflowInput } from "../application/investigationWorkflowInput.js";
import { reconcileInvestigation } from "../domain/investigationWorkflow.js";
import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import { logCliCommand } from "../cliLogging.js";
import type { CliInstance } from "./types.js";

/** Public JSON documents cannot authorise researchers or approve their own handoff. */
export const registerInvestigationWorkflowCommands = (
  cli: CliInstance,
  logger: Logger,
): void => {
  cli.command("reconcile-investigation", {
    description:
      "Preview two-researcher report and PRD gaps; caller-supplied receipts are never trusted",
    args: z.object({
      path: z
        .string()
        .describe("Unprotected regular JSON input file, at most one MiB"),
    }),
    run: ({ args }) =>
      logCliCommand(logger, "reconcile-investigation", async () => {
        const input = await readInvestigationWorkflowInput(args.path);
        return reconcileInvestigation(input, []);
      }),
  });
  cli.command("prepare-builder-handoff", {
    description:
      "Report whether a trusted researcher and independent specification-review boundary is available",
    run: () =>
      logCliCommand(logger, "prepare-builder-handoff", () => {
        throw new AnalysisCapabilityUnavailableError(
          "rea2-investigation",
          "prepare_builder_handoff",
          "Public documents cannot provide trusted research receipts or exclusion review. Use an enforcing orchestration boundary with the internal specification API.",
        );
      }),
  });
};
