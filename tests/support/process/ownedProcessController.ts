import {
  registerOwnedReceiver,
  hasPendingOwnedReceiver,
  recordReceiverFailure,
  stopOwnedReceiver,
  waitOwnedReceiverReady,
} from "./ownedProcessReceiver.js";
export { retryPendingOwnedProcessReceivers } from "./ownedProcessReceiver.js";
import { ownedCaptureFailure } from "./ownedProcessCaptureFailure.js";
import { OwnedProcessLifetime } from "./ownedProcessLifetime.js";
import {
  prepareOwnedProcessReadback,
  createOwnedReadbackCloser,
} from "./ownedProcessReadbackPorts.js";
export { retryPendingOwnedProcessReadbackSetup } from "./ownedProcessReadbackPorts.js";
import { spawn, type ChildProcess } from "node:child_process";
import { realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ProcessCliInputResources } from "../../../src/application/process/ProcessCliInputResources.js";
import { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import {
  releaseProcessCliCaptureResources,
  retryProcessCliCaptureCleanup,
} from "../../../src/application/process/ProcessCliCaptureResources.js";
import {
  isProcessCliFailure,
  processCliFailureCause,
  captureProcessScenarioFile,
} from "../../../src/application/process/ProcessCli.js";
import { createProcessCaptureEvidence } from "../../../src/application/process/ProcessEvidence.js";
import { parseEvidence, type Evidence } from "../../../src/domain/evidence.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { ok, err } from "../../../src/domain/result.js";
import { processScenarioSchema } from "../../../src/domain/process/processScenario.js";
import { analysisInputErrorFromIssues } from "../../../src/domain/inputIssueProjection.js";
import { ProcessCaptureError } from "../../../src/process/capture/ProcessCaptureError.js";
import { captureProcessScenario } from "../../../src/process/capture/ProcessHarness.js";
import {
  ProcessCaptureResourceScope,
  ProcessCaptureLifecycleCleanupFailure,
} from "../../../src/process/capture/ProcessCaptureLifecycle.js";
import {
  describeOwnedProcessTemplate,
  type OwnedProcessSelection,
} from "./ownedProcessTemplates.mjs";
import {
  ownedDirectoryIdentity,
  ownedFileIdentity,
  validateOwnedProcessControllerData,
  type OwnedProcessControllerData,
} from "./ownedProcessControllerProtocol.mjs";

import {
  OwnedProcessControllerResources,
  OwnedProcessCarrier,
} from "./ownedProcessControllerResources.mjs";

export interface OwnedProcessController {
  readonly validation: OwnedProcessControllerResources;
  readonly data: OwnedProcessControllerData;
  readonly inputs: ProcessCliInputResources;
  readonly dispose: () => Promise<void>;
}

const prepared = new WeakSet<OwnedProcessController>();
const used = new WeakSet<OwnedProcessController>();
const pendingControllers = new Set<OwnedProcessController>();
const controllerReceivers = new WeakMap<
  OwnedProcessController,
  Set<ChildProcess>
>();
const receiverSettlements = new WeakMap<ChildProcess, Promise<void>>();
const producerLifetimes = new WeakMap<
  OwnedProcessController,
  OwnedProcessLifetime
>();
const producerLifetime = (controller: OwnedProcessController) => {
  const lifetime = producerLifetimes.get(controller);
  if (lifetime === undefined)
    throw new Error("An owned controller is required");
  return lifetime;
};
const retainedCaptureScopes = new WeakMap<
  OwnedProcessController,
  Set<ProcessCaptureResourceScope>
>();
const freeze = <T>(value: T): T => {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

/** Prepare one explicit reviewed template, never target-supplied source or argv. */
export const prepareOwnedProcessController = async (
  selection: OwnedProcessSelection,
): Promise<OwnedProcessController> => {
  const snapshot = structuredClone(selection);
  const carrier = await OwnedProcessCarrier.create(await realpath(tmpdir()));
  const controlRoot = carrier.path;
  try {
    const validation = new OwnedProcessControllerResources();
    carrier.bindValidation(validation);
    const executable = await ownedFileIdentity(
      await realpath(
        snapshot.template === "printenv"
          ? "/usr/bin/printenv"
          : process.execPath,
      ),
      validation,
    );
    const program = join(controlRoot, "program.mjs");
    const scenario = join(controlRoot, "scenario.json");
    const description = describeOwnedProcessTemplate(
      snapshot,
      executable.path,
      program,
    );
    await writeFile(program, description.source, { flag: "wx", mode: 0o600 });
    await writeFile(scenario, JSON.stringify(description.scenario), {
      flag: "wx",
      mode: 0o600,
    });
    const directories = await Promise.all(
      [controlRoot, ...description.roots, ...description.directories].map(
        (path) =>
          ownedDirectoryIdentity(
            path,
            path === controlRoot || description.roots.includes(path),
          ),
      ),
    );
    const files = await Promise.all(
      [
        program,
        scenario,
        ...description.seeds.map(([path]) => path),
        executable.path,
      ].map((path) => ownedFileIdentity(path, validation)),
    );
    const data = freeze({
      selection: snapshot,
      control_root: controlRoot,
      program,
      scenario,
      directories,
      files,
      executable,
    });
    await validateOwnedProcessControllerData(data, validation);
    const inputs = new ProcessCliInputResources();
    let disposed = false;
    let disposing: Promise<void> | undefined;
    const disposalFailures: unknown[] = [];
    const controller = Object.freeze({
      data,
      inputs,
      validation,
      dispose: () => {
        if (disposed) return Promise.resolve();
        if (disposing) return disposing;
        // Retain the enclosing owner before any subordinate cleanup can fail.
        pendingControllers.add(controller);
        disposing = (async () => {
          try {
            const lifetime = producerLifetime(controller);
            lifetime.beginShutdown();
            const stopped = await Promise.allSettled(
              [...(controllerReceivers.get(controller) ?? [])].map(
                stopOwnedReceiver,
              ),
            );
            const stoppingFailures = stopped.flatMap((outcome) =>
              outcome.status === "rejected" ? [outcome.reason as unknown] : [],
            );
            if (stoppingFailures.length)
              throw new AggregateError(
                [...lifetime.failures, ...stoppingFailures],
                "Owned controller receivers remain active",
              );
            await lifetime.settle();
            const releases = await Promise.allSettled([
              inputs.close(),
              validation.close(),
              ...[...(retainedCaptureScopes.get(controller) ?? [])].map(
                retryProcessCliCaptureCleanup,
              ),
            ]);
            const failures = releases.flatMap((release) =>
              release.status === "rejected" ? [release.reason as unknown] : [],
            );
            if (failures.length)
              throw new AggregateError(
                [...lifetime.failures, ...failures],
                "Controller input and validation cleanup remain incomplete",
              );
            // Never remove the carrier while one of its subordinate scopes is pending.
            await carrier.close();
            disposed = true;
            pendingControllers.delete(controller);
          } catch (cause) {
            disposalFailures.push(cause);
            throw new AggregateError(
              [...producerLifetime(controller).failures, ...disposalFailures],
              "Enclosing controller cleanup attempts remain incomplete",
            );
          }
        })().finally(() => {
          disposing = undefined;
        });
        return disposing;
      },
    });
    producerLifetimes.set(controller, new OwnedProcessLifetime());
    controllerReceivers.set(controller, new Set());
    retainedCaptureScopes.set(controller, new Set());
    prepared.add(controller);
    pendingControllers.add(controller);
    return controller;
  } catch (cause: unknown) {
    carrier.retainSetupFailure(cause);
    try {
      await carrier.close();
    } catch (cleanup) {
      throw carrier.defer(cause, cleanup);
    }
    throw cause;
  }
};

/** Recover exact failed enclosing controllers, including all subordinate scopes. */
export const retryPendingOwnedProcessControllers = async (): Promise<void> => {
  const outcomes = await Promise.allSettled(
    [...pendingControllers].map((controller) => controller.dispose()),
  );
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason as unknown] : [],
  );
  if (failures.length)
    throw new AggregateError(failures, "Owned controllers remain retained");
};

const claim = async (controller: OwnedProcessController) => {
  if (!prepared.has(controller) || used.has(controller))
    throw new Error("An unused owned controller is required");
  used.add(controller);
  return validateOwnedProcessControllerData(
    controller.data,
    controller.validation,
  );
};

const assertOwnedDispatchOpen = (
  controller: OwnedProcessController,
  owner?: OwnedProcessLifetime,
): void => {
  producerLifetime(controller).assertOpen();
  owner?.assertOpen();
};

/** Every route registers both owners before claim, then rechecks after admission. */
const runAdmittedProducer = <T>(
  controller: OwnedProcessController,
  owner: OwnedProcessLifetime | undefined,
  signal: AbortSignal | undefined,
  dispatch: (raw: unknown, signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const lifetime = producerLifetime(controller);
  const admitted = async () => {
    assertOwnedDispatchOpen(controller, owner);
    const raw = await claim(controller);
    assertOwnedDispatchOpen(controller, owner);
    const signals = [
      lifetime.signal,
      ...(owner ? [owner.signal] : []),
      ...(signal ? [signal] : []),
    ];
    return dispatch(raw, AbortSignal.any(signals));
  };
  return lifetime.run(() => (owner ? owner.run(admitted) : admitted()));
};

/** Exercise the maintained CLI service directly; public REA launch remains denied. */
export const captureOwnedProcessCli = (
  controller: OwnedProcessController,
  signal?: AbortSignal,
) =>
  runAdmittedProducer(
    controller,
    undefined,
    signal,
    async (_raw, admittedSignal) => {
      try {
        const result = await captureProcessScenarioFile(
          controller.data.scenario,
          {},
          admittedSignal,
          controller.inputs,
        );
        if (isProcessCliFailure(result)) {
          const retained = processCliFailureCause(result);
          producerLifetime(controller).retainFailure(
            retained ? retained.cause : result,
          );
        }
        return result;
      } catch (cause: unknown) {
        if (cause instanceof ProcessCaptureLifecycleCleanupFailure)
          retainedCaptureScopes.get(controller)!.add(cause.resources);
        throw cause;
      }
    },
  );

/** Retain genuine capture Evidence in a real session; MCP only reads and derives it. */
export const connectOwnedProcessReadback = async () => {
  const {
    session,
    server,
    client,
    close: closeSetup,
    lifetime,
  } = await prepareOwnedProcessReadback();
  const scopes = new Map<ProcessCaptureResourceScope, OwnedProcessController>();
  const produce = async (
    raw: unknown,
    controller: OwnedProcessController,
    signal: AbortSignal,
  ) => {
    const failed = (cause: AnalysisError) => {
      producerLifetime(controller).retainFailure(cause);
      lifetime.retainFailure(cause);
      return err(cause);
    };
    const parsed = processScenarioSchema.safeParse(raw);
    if (!parsed.success)
      return failed(
        analysisInputErrorFromIssues(
          "capture_process_scenario",
          parsed.error.issues,
          raw,
          { cause: parsed.error },
        ),
      );
    const input = parsed.data;
    const scope = new ProcessCaptureResourceScope();
    scopes.set(scope, controller);
    retainedCaptureScopes.get(controller)!.add(scope);
    const result = await captureProcessScenario(
      input,
      signal,
      process.platform,
      {},
      undefined,
      undefined,
      undefined,
      scope,
    ).catch((cause: unknown) =>
      err(
        cause instanceof AnalysisError
          ? cause
          : new ProcessCaptureError("Owned process capture failed", {
              cause,
            }),
      ),
    );
    try {
      await releaseProcessCliCaptureResources(scope, result);
      scopes.delete(scope);
      retainedCaptureScopes.get(controller)!.delete(scope);
    } catch (cause: unknown) {
      return failed(
        cause instanceof AnalysisError
          ? cause
          : new ProcessCaptureError("Owned process cleanup failed", {
              cause,
            }),
      );
    }
    if (!result.ok) return failed(result.error);
    const evidence = createProcessCaptureEvidence(input, result.value);
    const recorded = session.recordEvidence(evidence);
    if (!recorded.ok) throw recorded.error;
    const response = await client.callTool({
      name: "get_evidence_bundle",
      arguments: {},
    });
    if (response.isError)
      throw new Error("MCP failed to retain actual process Evidence");
    const bundle = toolContract("get_evidence_bundle").outputSchema.parse(
      response.structuredContent,
    ).result;
    const retained = Array.isArray(bundle.records)
      ? bundle.records.find(
          (record) => record.evidence_id === evidence.evidence_id,
        )
      : undefined;
    if (
      retained === undefined ||
      JSON.stringify(parseEvidence(retained)) !==
        JSON.stringify(parseEvidence(evidence))
    )
      throw new Error("MCP failed to retain actual process Evidence");
    return ok(parseEvidence(evidence));
  };
  const capture = (
    controller: OwnedProcessController,
    signal?: AbortSignal,
  ): Promise<Evidence> =>
    runAdmittedProducer(
      controller,
      lifetime,
      signal,
      async (raw, admittedSignal) => {
        const result = await produce(raw, controller, admittedSignal);
        if (!result.ok) throw ownedCaptureFailure(result.error, admittedSignal);
        return result.value;
      },
    );
  const captureResponse = (
    controller: OwnedProcessController,
    signal?: AbortSignal,
  ) =>
    runAdmittedProducer(
      controller,
      lifetime,
      signal,
      async (raw, admittedSignal) => {
        const result = await produce(raw, controller, admittedSignal);
        const contract = toolContract("capture_process_scenario");
        return result.ok
          ? server.delivery.toEvidenceToolResult(
              result.value,
              contract,
              ok(null),
            )
          : server.delivery.toCallToolResult(result, contract);
      },
    );
  const close = createOwnedReadbackCloser(
    lifetime,
    scopes,
    closeSetup,
    (controller, scope) => retainedCaptureScopes.get(controller)!.delete(scope),
  );
  return {
    client,
    capture,
    captureResponse,
    call: (name: string, arguments_: Record<string, unknown>) =>
      client.callTool({ name, arguments: arguments_ }),
    close,
  };
};

/** Private test receiver invokes the same maintained CLI service with a sealed receipt. */
const startOwnedProcessCli = async (
  controller: OwnedProcessController,
  observe: (child: ChildProcess) => undefined,
): Promise<ChildProcess> => {
  const cwd = controller.data.selection.root;
  const root = controller.data.directories.find((value) => value.path === cwd);
  const current = await ownedDirectoryIdentity(cwd, true);
  if (
    root === undefined ||
    current.dev !== root.dev ||
    current.ino !== root.ino
  )
    throw new Error("Startup cwd identity changed");
  assertOwnedDispatchOpen(controller);
  const child = spawn(
    process.execPath,
    [
      fileURLToPath(
        new URL("./ownedProcessControllerReceiver.mjs", import.meta.url),
      ),
    ],
    {
      cwd,
      // The sealed fixtures live in macOS's user temporary directory. An empty
      // child environment otherwise changes tmpdir() to /tmp before validation.
      env:
        process.platform === "darwin"
          ? { TMPDIR: await realpath(tmpdir()) }
          : {},
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    },
  );
  controllerReceivers.get(controller)!.add(child);
  receiverSettlements.set(
    child,
    registerOwnedReceiver(child, controller, (cause) =>
      producerLifetime(controller).retainFailure(cause),
    ),
  );
  child.once("close", () => {
    if (!hasPendingOwnedReceiver(child))
      controllerReceivers.get(controller)!.delete(child);
  });
  const timer = setTimeout(() => {
    void stopOwnedReceiver(child).catch((cause: unknown) =>
      recordReceiverFailure(child, cause),
    );
  }, 30000);
  child.once("close", () => clearTimeout(timer));
  try {
    // Register readers before dispatch; no target-origin callback is accepted.
    const streamFailure = (cause: Error) => recordReceiverFailure(child, cause);
    child.stdout?.on("error", streamFailure);
    child.stderr?.on("error", streamFailure);
    child.once("close", () => {
      child.stdout?.removeListener("error", streamFailure);
      child.stderr?.removeListener("error", streamFailure);
    });
    try {
      observe(child);
    } finally {
      // Drain even when a controller-authored observer throws during setup.
      child.stdout?.resume();
      child.stderr?.resume();
    }
    assertOwnedDispatchOpen(controller);
    const pipe = child.stdio[3];
    if (pipe === null || pipe === undefined || !("end" in pipe))
      throw new Error("Missing private controller pipe");
    pipe.on("error", (cause) => {
      recordReceiverFailure(child, cause);
      void stopOwnedReceiver(child).catch((cleanup: unknown) =>
        recordReceiverFailure(child, cleanup),
      );
    });
    pipe.end(JSON.stringify(controller.data));
    await waitOwnedReceiverReady(child);
    return child;
  } catch (primary) {
    recordReceiverFailure(child, primary);
    try {
      await stopOwnedReceiver(child);
    } catch (cleanup) {
      throw new AggregateError(
        [primary, cleanup],
        "Receiver setup and cleanup failed",
      );
    }
    throw primary;
  }
};

/** The exact receiver stays in the carrier lifetime until its close event. */
export const spawnOwnedProcessCli = (
  controller: OwnedProcessController,
  observe: (child: ChildProcess) => undefined = () => undefined,
): Promise<ChildProcess> => {
  let resolveChild!: (child: ChildProcess) => void;
  let rejectChild!: (cause: unknown) => void;
  const returned = new Promise<ChildProcess>((resolve, reject) => {
    resolveChild = resolve;
    rejectChild = reject;
  });
  const task = runAdmittedProducer(
    controller,
    undefined,
    undefined,
    async () => {
      try {
        const child = await startOwnedProcessCli(controller, observe);
        resolveChild(child);
        await receiverSettlements.get(child);
      } catch (cause: unknown) {
        rejectChild(cause);
        await Promise.allSettled(
          [...(controllerReceivers.get(controller) ?? [])].map((child) =>
            receiverSettlements.get(child)!,
          ),
        );
        throw cause;
      }
    },
  );
  void task.catch(rejectChild);
  return returned;
};

/** Test observation teardown uses the same cooperative owner, never a direct kill. */
export const settleOwnedProcessCliReceiver = async (
  controller: OwnedProcessController,
  closed: Promise<unknown>,
): Promise<void> => {
  await controller.dispose();
  await closed;
};
