import { AnalysisProviderRegistry } from "./AnalysisProviderRegistry.js";
import { composeBinarySession } from "./BinarySessionComposition.js";
import type { DirectAnalysisSession } from "../DirectAnalysisDependencies.js";
import {
  requireOwnedStaticFixtureInventory,
  requireOwnedStaticFixtureOpen,
} from "../investigationSafety/OwnedStaticFixtureInventory.js";
import type {
  AnalysisOperation,
  AnalysisOperationPort,
} from "../AnalysisProvider.js";
import {
  AppleStaticArtifactProvider,
  isAppleStaticArtifactOperation,
} from "../../artifacts/AppleStaticArtifactProvider.js";
import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import { EvidenceIntegrityError } from "../../domain/evidenceErrors.js";
import { err } from "../../domain/result.js";

const controllers = new WeakSet<object>();
const unavailable = (operation: string) =>
  new AnalysisCapabilityUnavailableError(
    "owned-apple-static-fixture",
    operation,
    "This operation requires the exact controller-owned Apple static inventory scope.",
  );

/** Identity proof for a constructor-owned, immutable, engine-free session facade. */
export const isOwnedAppleStaticSession = (port: object): boolean =>
  controllers.has(port);

const guardAdmittedAnalysis = (
  admitted: AnalysisOperationPort,
  scopeError: (
    operation: string,
  ) => AnalysisCapabilityUnavailableError | undefined,
): AnalysisOperationPort =>
  Object.freeze<AnalysisOperationPort>({
    execute: (name, parameters, options) => {
      if (!isAppleStaticArtifactOperation(name))
        return Promise.resolve(err(unavailable(name)));
      const denied = scopeError(name);
      return denied === undefined
        ? admitted.execute(name, parameters, options)
        : Promise.resolve(err(denied));
    },
  });

/** No target reads occur until the matching sealed inventory scope admits them. */
export const createOwnedAppleStaticSession = (): DirectAnalysisSession => {
  const session = composeBinarySession(new AnalysisProviderRegistry([]), [
    new AppleStaticArtifactProvider(),
  ]);
  const open = session.open.bind(session);
  const execute = session.execute.bind(session);
  const withAdmittedAnalysis = session.withAdmittedAnalysis.bind(session);
  const scopeError = (operation: string) => {
    try {
      requireOwnedStaticFixtureInventory(controller, operation);
      return undefined;
    } catch {
      return unavailable(operation);
    }
  };
  const snapshotError = () =>
    new EvidenceIntegrityError(
      "Analysis snapshots are unavailable in the owned Apple static controller.",
    );
  const openScopeError = (path: string) => {
    try {
      requireOwnedStaticFixtureOpen(controller, path);
      return undefined;
    } catch {
      return unavailable("open_binary");
    }
  };
  const controller: DirectAnalysisSession =
    Object.freeze<DirectAnalysisSession>({
      open: async (path, options = {}) => {
        const denied = openScopeError(path);
        if (denied !== undefined) return err(denied);
        if (
          options.snapshot !== undefined ||
          options.providerId !== undefined ||
          options.formatHint !== undefined
        )
          return err(unavailable("open_binary"));
        return open(path, options);
      },
      execute: async (operation, parameters, options) => {
        if (!isAppleStaticArtifactOperation(operation))
          return err(unavailable(operation));
        const denied = scopeError(operation);
        return denied === undefined
          ? execute(operation, parameters, options)
          : err(denied);
      },
      withAdmittedAnalysis: async (operation, signal, callback) => {
        if (!isAppleStaticArtifactOperation(operation as AnalysisOperation))
          return err(unavailable(operation));
        const denied = scopeError(operation);
        if (denied !== undefined) return err(denied);
        return withAdmittedAnalysis(operation, signal, (admitted) =>
          callback(guardAdmittedAnalysis(admitted, scopeError)),
        );
      },
      close: session.close.bind(session),
      closeWithSnapshot: () =>
        Promise.resolve(err(unavailable("close_binary"))),
      previewTarget: () => Promise.resolve(err(unavailable("open_binary"))),
      openResolvedTarget: () =>
        Promise.resolve(err(unavailable("open_binary"))),
      status: session.status.bind(session),
      activeTarget: session.activeTarget.bind(session),
      providerIdentity: session.providerIdentity.bind(session),
      analysisProfile: session.analysisProfile.bind(session),
      allowsSnapshotReplay: () => false,
      exportAnalysisSnapshot: () =>
        err(unavailable("export_analysis_snapshot")),
      importAnalysisSnapshot: () =>
        err(unavailable("import_analysis_snapshot")),
      recordWorkflowSnapshot: () => err(snapshotError()),
      hasEvidence: session.hasEvidence.bind(session),
      evidenceById: session.evidenceById.bind(session),
      evidenceForAnalysis: session.evidenceForAnalysis.bind(session),
      evidenceBundleForSerialization:
        session.evidenceBundleForSerialization.bind(session),
      exportEvidenceBundle: session.exportEvidenceBundle.bind(session),
      importEvidenceBundle: session.importEvidenceBundle.bind(session),
      recordEvidence: session.recordEvidence.bind(session),
      recordEvidenceWithUnknown:
        session.recordEvidenceWithUnknown.bind(session),
      recordUnknown: session.recordUnknown.bind(session),
      updateUnknown: session.updateUnknown.bind(session),
      listUnknowns: session.listUnknowns.bind(session),
      verifyUnknownResolution: session.verifyUnknownResolution.bind(session),
      onAvailabilityChanged: session.onAvailabilityChanged.bind(session),
      onAnalysisSnapshotChanged:
        session.onAnalysisSnapshotChanged.bind(session),
    });
  controllers.add(controller);
  return controller;
};
