import type { AppConfig } from "../config/types.js";
import type { parseConfig } from "../config/parseConfig.js";
import type { Logger } from "pino";
import type { BinarySession } from "./binary/BinarySession.js";
import type { BinarySessionPort } from "./binary/BinarySessionPort.js";

/** Structural session boundary; provider implementations remain factory-owned. */
export type DirectAnalysisSession = BinarySessionPort &
  Pick<BinarySession, "previewTarget" | "openResolvedTarget">;

/** Configuration and one-shot session factories supplied by the production boundary. */
export interface DirectAnalysisDependencies {
  /** Read the caller-selected configuration without consulting ambient state. */
  readonly readConfiguration: () => ReturnType<typeof parseConfig>;
  readonly createBinarySession: (
    config: AppConfig,
    logger: Logger,
  ) => DirectAnalysisSession | Promise<DirectAnalysisSession>;
  readonly createManagedBinarySession: () =>
    | DirectAnalysisSession
    | Promise<DirectAnalysisSession>;
}
