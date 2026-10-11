import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { Logger } from "pino";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { analyzeSwiftSource } from "../application/swift/SwiftSourceService.js";
import { toolContract } from "../contracts/toolContracts.js";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind the inert mapper to the existing session admission, Evidence and resource owners. */
export const registerSwiftTools = (
  server: EvidenceMcpServer,
  options: {
    resources: ArtifactResourceScope;
    logger: Logger;
    recordEvidence?: EvidenceWriter["recordEvidence"] | undefined;
    admission?: WithAdmittedAnalysis | undefined;
  },
): void => {
  const contract = toolContract("analyze_swift_application");
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    createEvidenceToolHandler(
      server,
      (input, execution) =>
        analyzeSwiftSource(input, options.resources, execution),
      options.logger,
      options.recordEvidence,
      options.admission,
    )(contract),
  );
};
