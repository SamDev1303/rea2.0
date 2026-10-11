import { once } from "node:events";
import { expect, onTestFinished } from "vitest";
import { parseEvidence } from "../../src/domain/evidence.js";
import { webEventListenersSchema } from "../../src/domain/webEventListeners.js";
import { cliTest } from "../support/cli/cliFixture.js";
import { processTimingDiagnostics } from "../support/process/processTimingDiagnostics.js";
import {
  createOwnedWebRuntimeBrowser,
  createOwnedWebDiscoveryHang,
  runOwnedWebRuntimeCli,
  spawnOwnedWebRuntimeCli,
} from "../support/web/ownedWebRuntimeCliFixture.js";

cliTest(
  "preserves compiled listener behavior in the owned driver while public runtime admission is denied",
  async ({ cli, processes }) => {
    const fixture = await createOwnedWebRuntimeBrowser();
    onTestFinished(() => fixture.close());
    const denied = await cli.run({
      arguments: [
        "inspect-web-event-listeners",
        "http://127.0.0.1:1",
        "allowed-page",
        "#selected",
        "--json",
      ],
      environment: {},
    });
    expect(denied.json).toMatchObject({ code: "capability_unavailable" });
    expect(fixture.browser.commands).toHaveLength(0);
    const { stdout, stderr, exitCode } = await runOwnedWebRuntimeCli(
      processes,
      fixture.token,
      "inspect-web-event-listeners",
    );
    expect(exitCode, stderr).toBe(0);
    const result = webEventListenersSchema.parse(
      parseEvidence(JSON.parse(stdout)).normalized_result,
    );
    expect(result.listeners[0]?.location).toMatchObject({
      script_id: "script-a",
      source_association: "script_id",
    });
    expect(result.selected_node.selector).toBe("#selected");
  },
);

cliTest(
  "translates SIGINT after real CLI arming into awaited instrumentation cleanup and a nonzero CLI failure",
  async ({ processes }) => {
    const diagnostics = processTimingDiagnostics(
      "F159",
      "owned-web-cli-browser",
    );
    onTestFinished(() => diagnostics.persist());
    const fixture = await createOwnedWebRuntimeBrowser();
    diagnostics.mark("owned_fixture_created");
    onTestFinished(diagnostics.cleanup("web_browser", () => fixture.close()));
    const child = await spawnOwnedWebRuntimeCli(
      processes,
      fixture.token,
      "observe-web-execution",
    );
    diagnostics.mark("child_observed", { child_pid: child.pid ?? null });
    diagnostics.observeChild(child);
    child.once("close", () => {
      for (const [index, command] of fixture.browser.commands.entries())
        diagnostics.mark("cdp_command_observed_at_child_close", {
          index,
          method: command.method,
        });
    });
    let stderr = "";
    let stdout = "";
    let armed = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (
        !armed &&
        stderr.includes('"completed":1') &&
        stderr.includes("browser_execution")
      ) {
        armed = true;
        diagnostics.mark("arming_first_observed");
        diagnostics.mark("signal_send_started", { signal: "SIGINT" });
        const sent = child.kill("SIGINT");
        diagnostics.mark("signal_send_returned", { signal: "SIGINT", sent });
      }
    });
    const [code, signal] = await once(child, "close");
    expect(armed, stderr).toBe(true);
    expect(code, stderr).not.toBe(0);
    expect(signal).toBeNull();
    expect(JSON.parse(stdout)).toMatchObject({
      code: "cancelled",
      category: "cancelled",
      details: { cleanup: "complete", operation: "observe_web_execution" },
    });
    expect(
      fixture.browser.commands.some(
        (command) => command.method === "Profiler.stopPreciseCoverage",
      ),
    ).toBe(true);
    expect(
      fixture.browser.commands.some(
        (command) => command.method === "Target.detachFromTarget",
      ),
    ).toBe(true);
  },
);

const cancellationSignals =
  process.platform === "win32"
    ? (["SIGINT"] as const)
    : (["SIGINT", "SIGTERM"] as const);
const webRuntimeCancellationCases = (
  ["observe-web-execution", "inspect-web-event-listeners"] as const
).flatMap((command) =>
  cancellationSignals.map(
    (signal) => [command, signal, signal === "SIGINT" ? 130 : 143] as const,
  ),
);

cliTest.for(webRuntimeCancellationCases)(
  "%s preserves %s status when cancellation interrupts CDP discovery",
  async ([command, signal, expectedExitCode], { processes }) => {
    const caseId =
      command === "observe-web-execution"
        ? signal === "SIGINT"
          ? "F160"
          : "F161"
        : signal === "SIGINT"
          ? "F162"
          : "F163";
    const diagnostics = processTimingDiagnostics(
      caseId,
      "owned-web-cli-discovery",
    );
    diagnostics.mark("selected_case", {
      command,
      signal,
      expected_exit_code: expectedExitCode,
    });
    onTestFinished(() => diagnostics.persist());
    const fixture = await createOwnedWebDiscoveryHang();
    diagnostics.mark("owned_fixture_created");
    onTestFinished(diagnostics.cleanup("web_discovery", () => fixture.close()));
    let unrelatedContactWasAccepted = false;
    void fixture.contacted.then(() => {
      unrelatedContactWasAccepted = true;
    });
    await fixture.probeUnrelatedContact();
    expect(unrelatedContactWasAccepted).toBe(false);
    const child = await spawnOwnedWebRuntimeCli(
      processes,
      fixture.token,
      command,
    );
    diagnostics.mark("child_observed", { child_pid: child.pid ?? null });
    diagnostics.observeChild(child);
    const closed = once(child, "close");
    diagnostics.observeSettlement("web_cli_close", closed);
    onTestFinished(
      diagnostics.cleanup("web_cli_close", async () => {
        await closed;
      }),
    );
    let stdout = "";
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    let contactTimeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        fixture.contacted.then(() => {
          diagnostics.mark("cdp_contact_first_observed");
        }),
        new Promise<never>((_resolve, reject) => {
          contactTimeout = setTimeout(() => {
            diagnostics.mark("contact_wait_timeout", { timeout_ms: 5000 });
            reject(new Error("CLI did not contact the CDP fixture"));
          }, 5000);
        }),
      ]);
    } finally {
      if (contactTimeout !== undefined) clearTimeout(contactTimeout);
    }
    diagnostics.mark("signal_send_started", { signal });
    const sent = child.kill(signal);
    diagnostics.mark("signal_send_returned", { signal, sent });
    const [exitCode, terminationSignal] = await closed;
    expect(terminationSignal).toBeNull();
    expect(exitCode, `${stdout}\n${stderr}`).toBe(expectedExitCode);
    expect(JSON.parse(stdout)).toMatchObject({
      code: "cancelled",
      category: "cancelled",
      details: { cleanup: "complete" },
    });
  },
);

cliTest(
  "refuses forged and closed fixture tokens before spawning a runtime child",
  async ({ processes }) => {
    await expect(
      runOwnedWebRuntimeCli(
        processes,
        { fixture: "owned-web-runtime-endpoint" },
        "observe-web-execution",
      ),
    ).rejects.toThrow("Only a live constructor-owned web fixture");
    const fixture = await createOwnedWebRuntimeBrowser();
    await fixture.close();
    await expect(
      runOwnedWebRuntimeCli(processes, fixture.token, "observe-web-execution"),
    ).rejects.toThrow("Only a live constructor-owned web fixture");
    expect(fixture.browser.commands).toHaveLength(0);
  },
);
