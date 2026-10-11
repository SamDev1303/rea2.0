import { z } from "zod";
import type { CliInstance } from "./types.js";
import { withCommandCancellation } from "./commandCancellation.js";
import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { analyzeSwiftSource } from "../application/swift/SwiftSourceService.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { CLI_COMMANDS } from "../cliCommandNames.js";
import { SWIFT_SOURCE_OPERATION } from "../application/swift/SwiftSourceService.js";
import { SWIFT_SOURCE_PROVIDER } from "../application/InvestigationProviders.js";

/** Run the source mapper through protected admission and owned one-shot cleanup. */
export const registerSwiftCommands = (cli: CliInstance): void => {
  cli.command(CLI_COMMANDS.analyzeSwiftApplication, {
    description:
      "Map inert Swift source declarations, imports and unresolved call candidates",
    args: z.object({
      path: z
        .string()
        .min(1)
        .describe("Approved directory of extracted UTF-8 Swift source"),
    }),
    run: async ({ args }) => {
      let cleanupIncomplete = false;
      const output = await withCommandCancellation(async (signal) => {
        const resources = new ArtifactResourceScope();
        const result = await analyzeSwiftSource(
          { input_path: args.path },
          resources,
          { signal },
        );
        try {
          await resources.close();
        } catch (cause: unknown) {
          cleanupIncomplete = true;
          const observation = ArtifactReaderFailure.cleanupObservation(
            cause,
            "Swift source resources",
          );
          const cleanup = new ProviderCleanupError(
            SWIFT_SOURCE_PROVIDER.id,
            observation.resources,
            { reason: observation.reason },
            { cause, operation: SWIFT_SOURCE_OPERATION },
          );
          process.exitCode = 1;
          return {
            error: "Swift source analysis failed",
            ...projectAnalysisError(
              result.ok
                ? cleanup
                : analysisErrorWithCleanupFailure(
                    result.error,
                    cleanup,
                    SWIFT_SOURCE_OPERATION,
                  ),
            ),
          };
        }
        if (!result.ok) {
          cleanupIncomplete = result.error.cleanupIncomplete;
          process.exitCode = 1;
        }
        return result.ok
          ? result.value
          : {
              error: "Swift source analysis failed",
              ...projectAnalysisError(result.error),
            };
      });
      // Incomplete cleanup takes priority over a normal cancellation status.
      if (cleanupIncomplete) process.exitCode = 1;
      return output;
    },
  });
};
