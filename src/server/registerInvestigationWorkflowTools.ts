import { jsonValueSchema } from "../domain/jsonValue.js";
import { reconcileInvestigation } from "../domain/investigationWorkflow.js";
import { INVESTIGATION_WORKFLOW_TOOL_CONTRACTS } from "../contracts/investigationWorkflowToolContracts.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { runDerivedOperation } from "./runDerivedOperation.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import { ok } from "../domain/result.js";

/** Pure previews only; no public JSON input is treated as trusted run authority. */
export const registerInvestigationWorkflowTools = (
  server: EvidenceMcpServer,
): void => {
  const [reconcile, handoff] = INVESTIGATION_WORKFLOW_TOOL_CONTRACTS;
  server.registerTool(
    reconcile.name,
    toolRegistrationOptions(reconcile),
    async (input, context) => {
      const computed = await runDerivedOperation(context, reconcile.name, () =>
        jsonValueSchema.parse(reconcileInvestigation(input.investigation, [])),
      );
      return server.delivery.toCallToolResult(computed, reconcile);
    },
  );
  server.registerTool(
    handoff.name,
    toolRegistrationOptions(handoff),
    async () =>
      server.delivery.toCallToolResult(
        ok({
          status: "unavailable" as const,
          reason:
            "No trusted research-launch or specification-review boundary is injected into this public endpoint.",
        }),
        handoff,
      ),
  );
};
