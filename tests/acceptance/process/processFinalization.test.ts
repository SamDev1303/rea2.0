import { access, readFile } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, onTestFinished } from "vitest";

import { projectProcessCliError } from "../../../src/application/process/ProcessCli.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { partialProcessCaptureObservationSchema } from "../../../src/domain/process/processCapture.js";
import { observeProcessStartIdentity } from "../../../src/process/ProcessOwnershipObservation.js";
import {
  parseProcessCapture,
  type ProcessCapture,
} from "../../../src/domain/process/processCaptureParsing.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  prepareOwnedProcessController,
  captureOwnedProcessCli,
  connectOwnedProcessReadback,
  spawnOwnedProcessCli,
  settleOwnedProcessCliReceiver,
} from "../../support/process/ownedProcessController.js";
import type { OwnedProcessSelection } from "../../support/process/ownedProcessTemplates.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { itWithCaptureCapability as captureTest } from "../../boundary/process/processCaptureCapability.js";
import { expectSerializedUnverifiedHostCleanup } from "../../support/hostCleanup.js";
import { processTimingDiagnostics } from "../../support/process/processTimingDiagnostics.js";

type CaptureScenario = Record<string, unknown>;
type CaptureOutcome =
  | { readonly kind: "capture"; readonly capture: ProcessCapture }
  | { readonly kind: "partial"; readonly partial: unknown };

const captureScenario = (
  mode: "cooperative" | "ignoring" | "descendant",
  root: string,
  additions: CaptureScenario = {},
  finalExitCode?: 0 | 3,
): OwnedProcessSelection => {
  const variants = [
    ["standard", { timeout_ms: 1500, finalization_ms: 1500 }],
    [
      "descendant",
      {
        timeout_ms: 1500,
        finalization_ms: 1500,
        settle_ms: 100,
        limits: { file_bytes: 1 },
      },
    ],
    ["default", { timeout_ms: 500 }],
    ["cancel", { timeout_ms: 300, finalization_ms: 20000 }],
    [
      "invalid-budget",
      { timeout_ms: Number.MAX_SAFE_INTEGER, finalization_ms: 1, settle_ms: 0 },
    ],
  ] as const;
  const match = variants.find(
    ([, value]) => JSON.stringify(value) === JSON.stringify(additions),
  );
  if (match === undefined)
    throw new Error("Unknown authored finalization variant");
  return {
    template: "finalization",
    root,
    mode,
    timing: match[0],
    ...(finalExitCode === undefined ? {} : { exitCode: finalExitCode }),
  };
};

const captureViaCli = async (
  _root: string,
  scenario: OwnedProcessSelection,
): Promise<CaptureOutcome> => {
  const controller = await prepareOwnedProcessController(scenario);
  onTestFinished(controller.dispose);
  const document = await captureOwnedProcessCli(controller);
  if (
    typeof document === "object" &&
    document !== null &&
    "code" in document &&
    document.code === "cleanup_incomplete"
  )
    return {
      kind: "partial",
      partial: expectSerializedUnverifiedHostCleanup({ error: document }),
    };
  if (typeof document === "object" && document !== null && "code" in document)
    throw new Error(
      `CLI capture returned an unexpected error: ${JSON.stringify(document).slice(0, 1_000)}`,
    );
  return {
    kind: "capture",
    capture: parseProcessCapture(parseEvidence(document).normalized_result),
  };
};

const captureViaMcp = async (
  scenario: OwnedProcessSelection,
): Promise<CaptureOutcome> => {
  const controller = await prepareOwnedProcessController(scenario);
  onTestFinished(controller.dispose);
  const readback = await connectOwnedProcessReadback();
  onTestFinished(readback.close);
  const response = await readback.captureResponse(controller);
  if (response.isError === true) {
    const parsed = parseMcpToolError(response);
    if (parsed.error.code === "cleanup_incomplete")
      return {
        kind: "partial",
        partial: expectSerializedUnverifiedHostCleanup(parsed),
      };
    throw new Error(
      `MCP capture returned an unexpected error: ${JSON.stringify(parsed).slice(0, 1_000)}`,
    );
  }
  return {
    kind: "capture",
    capture: parseProcessCapture(
      parseEvidence(
        toolContract("capture_process_scenario").outputSchema.parse(
          response.structuredContent,
        ),
      ).normalized_result,
    ),
  };
};

const waitFor = async (
  description: string,
  predicate: () => Promise<boolean>,
  deadlineMs = 7_500,
): Promise<void> => {
  const deadline = Date.now() + deadlineMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline)
      throw new Error(`timed out waiting for ${description}`);
    await delay(25);
  }
};

const fixturePid = async (root: string): Promise<number> => {
  let pid = Number.NaN;
  await waitFor("the finalization fixture PID", async () => {
    try {
      pid = Number.parseInt(await readFile(join(root, "pid.txt"), "utf8"), 10);
      return Number.isSafeInteger(pid) && pid > 0;
    } catch {
      return false;
    }
  });
  return pid;
};

const waitForObservedFinalization = async (
  root: string,
  stage: string,
  diagnostics: ReturnType<typeof processTimingDiagnostics>,
) => {
  let observedPid = false;
  diagnostics.mark(`${stage}_finalization_wait_started`);
  try {
    await waitFor("the finalization fixture to receive SIGTERM", async () => {
      if (!observedPid) {
        try {
          const pid = Number.parseInt(
            await readFile(join(root, "pid.txt"), "utf8"),
            10,
          );
          if (Number.isSafeInteger(pid) && pid > 0) {
            observedPid = true;
            diagnostics.mark(`${stage}_target_pid_observed`, { pid });
          }
        } catch {
          // This authored marker is absent until the owned target starts.
        }
      }
      try {
        await access(join(root, "sigterm-received"));
        diagnostics.mark(`${stage}_sigterm_marker_observed`);
        return true;
      } catch {
        return false;
      }
    });
    return await fixturePid(root);
  } catch (cause) {
    diagnostics.mark(`${stage}_finalization_wait_failed`, {
      target_pid_observed: observedPid,
      message: cause instanceof Error ? cause.message : String(cause),
    });
    throw cause;
  }
};

const abortProducerOnTeardown = (
  controller: AbortController,
  diagnostics: ReturnType<typeof processTimingDiagnostics>,
  producer: Promise<unknown>,
) => {
  onTestFinished(async () => {
    if (!controller.signal.aborted) {
      diagnostics.mark("producer_teardown_abort_requested");
      controller.abort(new Error("finalization fixture test teardown"));
    }
    // Observe settlement without replacing the original promise or rejection.
    await Promise.allSettled([producer]);
    diagnostics.mark("producer_teardown_settled");
  });
};

const interruptReceiver = (
  receiver: ChildProcess,
  diagnostics: ReturnType<typeof processTimingDiagnostics>,
) => {
  diagnostics.mark("cli_sigint_requested", { pid: receiver.pid ?? null });
  const sent = receiver.kill("SIGINT");
  diagnostics.mark("cli_sigint_sent", { sent });
};

const waitForProcessExit = async (pid: number): Promise<void> =>
  waitFor(`finalization fixture ${String(pid)} to exit`, async () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error: unknown) {
      return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      );
    }
  });

const finalizationFromPartial = (partial: unknown) => {
  const parsed = partialProcessCaptureObservationSchema.parse(partial);
  if ("capture" in parsed) return parsed.capture.exit.finalization;
  return parsed.observations.exit.state === "available"
    ? parsed.observations.exit.value.finalization
    : undefined;
};

const completedCaptureFromOutcome = (outcome: CaptureOutcome) => {
  if (outcome.kind === "capture") return outcome.capture;
  const partial = partialProcessCaptureObservationSchema.parse(outcome.partial);
  expect(partial.execution_failure).toBeNull();
  if (!("capture" in partial))
    throw new Error("host cleanup uncertainty omitted the completed capture");
  return partial.capture;
};

const expectCooperativeFinalization = (
  outcome: CaptureOutcome,
  expectedExitCode = 0,
): void => {
  const capture = completedCaptureFromOutcome(outcome);
  expect(capture.exit.reason, "the deadline remains the exit reason").toBe(
    "timeout",
  );
  expect(capture.exit.code, "a deadline exit has no normal code").toBeNull();
  expect(
    capture.exit.finalization,
    "the cooperative target receives only SIGTERM",
  ).toMatchObject({
    requested_ms: 1_500,
    signals: [{ signal: "SIGTERM", delivery: "signaled" }],
  });
  expect(
    capture.exit.finalization?.signals,
    "cooperative finalization does not send SIGKILL",
  ).toHaveLength(1);
  expect(
    capture.exit.finalization?.elapsed_ms,
    "the cooperative target exits within its interval",
  ).toBeLessThan(1_500);
  expect(
    capture.exit.finalization?.exit_code,
    "the code the finalizer exited with is recorded",
  ).toBe(expectedExitCode);
  expect(
    capture.frames.map(({ data }) => data).join(""),
    "finalization output is captured",
  ).toContain("finalized");
  expect(
    capture.files_after.find(({ path }) => path.endsWith("final.json"))?.sha256,
    "the final filesystem snapshot hashes the final report",
  ).toMatch(/^[0-9a-f]{64}$/u);
  expect(
    capture.manifest.scenario.finalization_ms,
    "the scenario commitment retains finalization_ms",
  ).toBe(1_500);
  expect(
    capture.manifest.comparison_contract.finalization_ms,
    "the comparison contract retains finalization_ms",
  ).toBe(1_500);
};

const expectIgnoringFinalization = (outcome: CaptureOutcome): void => {
  const capture = completedCaptureFromOutcome(outcome);
  expect(capture.exit.reason, "the deadline remains the exit reason").toBe(
    "timeout",
  );
  expect(capture.exit.signal, "the ignoring child ends on SIGKILL").toBe(9);
  expect(
    capture.exit.finalization?.signals,
    "SIGTERM is followed by exactly one SIGKILL",
  ).toMatchObject([
    { signal: "SIGTERM", delivery: "signaled" },
    { signal: "SIGKILL", delivery: "signaled" },
  ]);
  expect(
    capture.exit.finalization?.signals,
    "the ignoring child has exactly two finalization attempts",
  ).toHaveLength(2);
  expect(
    capture.exit.finalization?.signals[1]?.sent_at_ms,
    "SIGKILL waits for the requested interval",
  ).toBeGreaterThanOrEqual(1_500);
  expect(
    capture.exit.finalization?.elapsed_ms,
    "the elapsed finalization duration is observed",
  ).toEqual(expect.any(Number));
  expect(
    capture.exit.finalization?.exit_code,
    "an exit ended by SIGKILL records no code",
  ).toBeNull();
  expect(
    capture.files_after.find(({ path }) => path.endsWith("final.json")),
    "an ignoring child does not write a final report",
  ).toBeUndefined();
};

captureTest.each(["CLI", "MCP"] as const)(
  "captures a cooperative finalizer through the compiled %s workflow",
  async (adapter) => {
    const root = await createTestTempDirectory("rea-finalization-accept-");
    const scenario = captureScenario("cooperative", root, {
      timeout_ms: 1_500,
      finalization_ms: 1_500,
    });
    const outcome =
      adapter === "CLI"
        ? await captureViaCli(root, scenario)
        : await captureViaMcp(scenario);
    expectCooperativeFinalization(outcome);
  },
  20_000,
);

captureTest.each(["CLI", "MCP"] as const)(
  "records the non-zero exit code of a finalizer through the compiled %s workflow",
  async (adapter) => {
    const root = await createTestTempDirectory("rea-finalization-accept-");
    const scenario = captureScenario(
      "cooperative",
      root,
      { timeout_ms: 1_500, finalization_ms: 1_500 },
      3,
    );
    const outcome =
      adapter === "CLI"
        ? await captureViaCli(root, scenario)
        : await captureViaMcp(scenario);
    expectCooperativeFinalization(outcome, 3);
  },
  20_000,
);

captureTest.each(["CLI", "MCP"] as const)(
  "forces SIGKILL after the finalization interval through the compiled %s workflow",
  async (adapter) => {
    const root = await createTestTempDirectory("rea-finalization-accept-");
    const scenario = captureScenario("ignoring", root, {
      timeout_ms: 1_500,
      finalization_ms: 1_500,
    });
    const outcome =
      adapter === "CLI"
        ? await captureViaCli(root, scenario)
        : await captureViaMcp(scenario);
    expectIgnoringFinalization(outcome);
  },
  20_000,
);

captureTest(
  "retains finalization facts with omitted digests and cleans the owned descendant",
  async () => {
    const root = await createTestTempDirectory("rea-finalization-descendant-");
    const childDirectory = join(root, "descendant");
    const outcome = await captureViaMcp(
      captureScenario("descendant", root, {
        timeout_ms: 1_500,
        finalization_ms: 1_500,
        settle_ms: 100,
        limits: { file_bytes: 1 },
      }),
    );
    const capture = completedCaptureFromOutcome(outcome);
    expect(capture.exit).toMatchObject({
      reason: "timeout",
      code: null,
      finalization: {
        exit_code: 0,
        signals: [{ signal: "SIGTERM", delivery: "signaled" }],
      },
    });
    expect(capture.exit.finalization?.signals).toHaveLength(1);
    expect(capture.settlement).toMatchObject({
      state: "alive_at_deadline",
      cleanup_outcome: "cleaned",
    });
    expect(capture.frames.map(({ data }) => data).join("")).toContain(
      "finalized",
    );
    const final = capture.files_after.find(({ path }) =>
      path.endsWith(":final.json"),
    );
    expect(final).toMatchObject({ type: "file", sha256: null });
    expect(capture.truncation_details.filesystem_after).toMatchObject({
      enumeration_truncated: false,
      hash_budget_bytes: 1,
      hash_omissions: expect.arrayContaining([
        expect.objectContaining({
          path: final?.path,
          reason: "file_bytes_budget",
        }),
      ]),
    });
    expect(
      JSON.parse(await readFile(join(root, "final.json"), "utf8")),
    ).toEqual({
      phase: "final",
    });
    await expect(
      access(join(childDirectory, "sigterm-received")),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
    const childPid = await fixturePid(childDirectory);
    await expect(
      observeProcessStartIdentity(childPid),
    ).resolves.toBeUndefined();
  },
  20_000,
);

captureTest.each(["CLI", "MCP"] as const)(
  "keeps the default identity through the compiled %s workflow without finalization_ms",
  async (adapter) => {
    const root = await createTestTempDirectory("rea-finalization-default-");
    const scenario = captureScenario("ignoring", root, { timeout_ms: 500 });
    const outcome =
      adapter === "CLI"
        ? await captureViaCli(root, scenario)
        : await captureViaMcp(scenario);
    if (outcome.kind === "partial") {
      expect(
        finalizationFromPartial(outcome.partial),
        "the cleanup-flake partial observation has no default finalization",
      ).toBeUndefined();
      return;
    }
    expect(
      outcome.capture.exit,
      "default captures have no finalization evidence",
    ).not.toHaveProperty("finalization");
    expect(
      outcome.capture.manifest.scenario,
      "the committed scenario keeps its legacy identity",
    ).not.toHaveProperty("finalization_ms");
    expect(
      outcome.capture.manifest.comparison_contract,
      "the comparison contract keeps its legacy identity",
    ).not.toHaveProperty("finalization_ms");
  },
  20_000,
);

captureTest.each(["CLI", "MCP"] as const)(
  "rejects an unrepresentable combined capture budget through the compiled %s workflow",
  async (adapter) => {
    const root = await createTestTempDirectory("rea-finalization-budget-");
    const scenario = captureScenario("cooperative", root, {
      timeout_ms: Number.MAX_SAFE_INTEGER,
      finalization_ms: 1,
      settle_ms: 0,
    });
    if (adapter === "CLI") {
      const controller = await prepareOwnedProcessController(scenario);
      onTestFinished(controller.dispose);
      const response = await captureOwnedProcessCli(controller);
      expect(
        JSON.stringify(response),
        "CLI rejects the combined budget",
      ).toContain("timeout_ms + finalization_ms + settle_ms");
    } else {
      const controller = await prepareOwnedProcessController(scenario);
      onTestFinished(controller.dispose);
      const readback = await connectOwnedProcessReadback();
      onTestFinished(readback.close);
      const response = await readback.captureResponse(controller);
      expect(response.isError, "MCP rejects the combined budget").toBe(true);
      expect(
        JSON.stringify(response),
        "MCP explains the combined budget",
      ).toContain("timeout_ms + finalization_ms + settle_ms");
    }
    await expect(
      access(join(root, "periodic.json")),
      "invalid budgets are rejected before launching the fixture",
    ).rejects.toMatchObject({ code: "ENOENT" });
  },
);

captureTest(
  "cancels the compiled CLI and MCP workflows during finalization without waiting for grace",
  async () => {
    const diagnostics = processTimingDiagnostics("F182");
    onTestFinished(() => diagnostics.persist());
    const cliRoot = await createTestTempDirectory(
      "rea-finalization-cli-cancel-",
    );
    const cliController = await prepareOwnedProcessController(
      captureScenario("ignoring", cliRoot, {
        timeout_ms: 300,
        finalization_ms: 20000,
      }),
    );
    onTestFinished(
      diagnostics.cleanup("cli_controller", cliController.dispose),
    );
    let stdout = "";
    let cliClosed!: Promise<{ readonly code: number | null }>;
    const cli = await spawnOwnedProcessCli(cliController, (receiver) => {
      diagnostics.mark("cli_receiver_spawned", { pid: receiver.pid ?? null });
      receiver.stdout!.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      diagnostics.observeChild(receiver);
      cliClosed = new Promise((resolve, reject) => {
        receiver.once("error", reject);
        receiver.once("close", (code) => resolve({ code }));
      });
      diagnostics.observeSettlement("cli_closed_promise", cliClosed);
    });
    // The pre-dispatch observer keeps the original rejection for both later awaits.
    onTestFinished(
      diagnostics.cleanup("cli_receiver", async () => {
        await settleOwnedProcessCliReceiver(cliController, cliClosed);
      }),
    );
    const cliFixturePid = await waitForObservedFinalization(
      cliRoot,
      "cli",
      diagnostics,
    );
    const cliStarted = Date.now();
    interruptReceiver(cli, diagnostics);
    const cliExit = await cliClosed;
    await waitForProcessExit(cliFixturePid);
    diagnostics.mark("cli_target_exit_observed", { pid: cliFixturePid });
    expect(
      Date.now() - cliStarted,
      "CLI cancellation does not wait for the grace interval",
    ).toBeLessThan(8_000);
    const cliDocument: unknown = JSON.parse(stdout);
    diagnostics.outcome("cli_outcome_parsed", cliDocument);
    if (
      typeof cliDocument === "object" &&
      cliDocument !== null &&
      "code" in cliDocument &&
      cliDocument.code === "cleanup_incomplete"
    ) {
      expect(
        cliExit.code,
        "incomplete cleanup reports failure despite cancellation",
      ).toBe(1);
      const partial = expectSerializedUnverifiedHostCleanup({
        error: cliDocument,
      });
      expect(
        finalizationFromPartial(partial),
        "CLI cleanup-flake partial observation records SIGKILL",
      ).toMatchObject({
        signals: [{ signal: "SIGTERM" }, { signal: "SIGKILL" }],
      });
    } else {
      expect(cliExit.code, "clean cancellation retains status130").toBe(130);
      expect(cliDocument, "CLI returns a typed cancelled result").toMatchObject(
        {
          code: "cancelled",
        },
      );
    }

    const mcpRoot = await createTestTempDirectory(
      "rea-finalization-mcp-cancel-",
    );
    const readback = await connectOwnedProcessReadback();
    onTestFinished(diagnostics.cleanup("producer_readback", readback.close));
    const mcpController = await prepareOwnedProcessController(
      captureScenario("ignoring", mcpRoot, {
        timeout_ms: 300,
        finalization_ms: 20000,
      }),
    );
    onTestFinished(
      diagnostics.cleanup("producer_controller", mcpController.dispose),
    );
    const controller = new AbortController();
    diagnostics.mark("producer_capture_started");
    const call = readback.capture(mcpController, controller.signal);
    abortProducerOnTeardown(controller, diagnostics, call);
    diagnostics.observeProducer(call);
    const mcpFixturePid = await waitForObservedFinalization(
      mcpRoot,
      "producer",
      diagnostics,
    );
    const mcpStarted = Date.now();
    diagnostics.mark("producer_abort_requested");
    controller.abort(new Error("cancel finalization acceptance fixture"));
    const mcpFailure = await call.then(
      () => {
        throw new Error("Cancellation unexpectedly completed");
      },
      (cause: unknown) => cause,
    );
    expect(
      mcpFailure,
      "Owned capture cancellation rejects the pending producer request",
    ).toBeInstanceOf(Error);
    const mcpProjected = projectProcessCliError(mcpFailure);
    diagnostics.mark("producer_outcome_projected", {
      json: JSON.stringify(mcpProjected),
    });
    if ("code" in mcpProjected && mcpProjected.code === "cleanup_incomplete") {
      const partial = expectSerializedUnverifiedHostCleanup({
        error: mcpProjected,
      });
      expect(
        finalizationFromPartial(partial),
        "MCP retains finalization evidence when cancellation cleanup is unverified",
      ).toMatchObject({
        signals: [{ signal: "SIGTERM" }, { signal: "SIGKILL" }],
      });
    } else {
      expect(mcpFailure).toMatchObject({
        message: "cancel finalization acceptance fixture",
        reason: "cancelled",
      });
      expect(mcpProjected).toMatchObject({ code: "cancelled" });
    }
    await waitForProcessExit(mcpFixturePid);
    diagnostics.mark("producer_target_exit_observed", { pid: mcpFixturePid });
    await expect(
      readback.client.listTools(),
      "the server accepts a follow-up request after cancelling the capture",
    ).resolves.toMatchObject({ tools: expect.any(Array) });
    diagnostics.mark("mcp_followup_list_tools_passed");
    expect(
      Date.now() - mcpStarted,
      "MCP cancellation does not wait for the grace interval",
    ).toBeLessThan(8_000);
  },
  20_000,
);
