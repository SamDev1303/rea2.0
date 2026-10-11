import { snapshotEnvironment } from "../process/snapshotEnvironment.js";
import { parseConfig } from "../config/parseConfig.js";
import {
  runDirectAnalysis as executeDirectAnalysis,
  runProviderAnalysis as executeProviderAnalysis,
  runManagedProviderExecution as executeManagedProvider,
} from "../application/DirectAnalysis.js";
import { runSessionStatus as executeSessionStatus } from "../application/DirectAnalysisStatus.js";
import type {
  DirectAnalysisDependencies,
  DirectAnalysisSession,
} from "../application/DirectAnalysisDependencies.js";
import { isOwnedAppleStaticSession } from "./OwnedAppleStaticSession.js";

/** Bind one-shot analysis and status commands to one caller-selected environment. */
export const createDirectAnalysis = (
  selectedEnvironment: Readonly<Record<string, string | undefined>>,
  ownedStaticSession?: DirectAnalysisSession,
) => {
  if (
    ownedStaticSession !== undefined &&
    !isOwnedAppleStaticSession(ownedStaticSession)
  )
    throw new Error(
      "The owned static controller requires its factory identity",
    );
  const environment = snapshotEnvironment(selectedEnvironment);
  const dependencies: DirectAnalysisDependencies = {
    readConfiguration: () => parseConfig(environment),
    createBinarySession: async (config, logger) => {
      if (ownedStaticSession !== undefined) return ownedStaticSession;
      const { createBinarySession } = await import("./binary.js");
      return createBinarySession(config, logger, environment);
    },
    createManagedBinarySession: async () => {
      const { createManagedBinarySession } = await import("./binary.js");
      return createManagedBinarySession();
    },
  };
  return {
    runDirectAnalysis: executeDirectAnalysis.bind(undefined, dependencies),
    runProviderAnalysis: executeProviderAnalysis.bind(undefined, dependencies),
    runSessionStatus: executeSessionStatus.bind(undefined, dependencies),
  };
};

/** Bound operations used by CLI command registration. */
export type DirectAnalysis = ReturnType<typeof createDirectAnalysis>;

/** Execute managed metadata without configuration or native provider candidates. */
export const runManagedProviderExecution = executeManagedProvider.bind(
  undefined,
  {
    createManagedBinarySession: async () => {
      const { createManagedBinarySession } = await import("./binary.js");
      return createManagedBinarySession();
    },
  },
);
