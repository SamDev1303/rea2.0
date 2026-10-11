import { execFile, spawn } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import pino from "pino";
import { expect, onTestFinished } from "vitest";
import { z } from "zod";
import { analysisCliErrorEnvelopeSchema } from "../../../src/contracts/errorSchemas.js";
import { processScenarioSchema } from "../../../src/domain/process/processScenario.js";
import { captureProcessScenario } from "../../../src/process/capture/ProcessHarness.js";
import { ProcessCaptureResourceScope } from "../../../src/process/capture/ProcessCaptureLifecycle.js";
import { cleanupOwnedProcessGroup } from "../../../src/process/ProcessOwnership.js";
import { createServer } from "../../../src/server/createServer.js";
import { logToolExecution } from "../../../src/server/toolLogging.js";
import { processTest } from "../../support/process/processFixture.js";
import {
  createDeferred,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { itWithCaptureCapability } from "./processCaptureCapability.js";

const fixture = fileURLToPath(
  new URL("../../fixtures/processCaptureCancellation.mjs", import.meta.url),
);
const exec = promisify(execFile);
// This is controller-authored test code, not a target or a public execution
// grant. It exercises the same command cancellation helper and capture service
// with real process signals, in the declared synthetic temporary workspace.
const commandWorker = (scenario: string): string => `
import { captureProcessScenarioFile } from ${JSON.stringify(new URL("../../../dist/application/process/ProcessCli.js", import.meta.url).href)};
import { withCommandCancellation } from ${JSON.stringify(new URL("../../../dist/cli/commandCancellation.js", import.meta.url).href)};
const result = await withCommandCancellation(signal => captureProcessScenarioFile(${JSON.stringify(scenario)}, {}, signal));
process.stdout.write(JSON.stringify(result));
`;
const markerSchema = z.object({
  rootPid: z.number().int().positive(),
  childPid: z.number().int().positive().optional(),
  runId: z.string().min(1),
});
type Marker = z.infer<typeof markerSchema>;

const readMarker = async (root: string): Promise<Marker> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      return markerSchema.parse(
        JSON.parse(await readFile(join(root, "ready.json"), "utf8")),
      );
    } catch (cause: unknown) {
      if (
        !(cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      )
        throw cause;
    }
    await delay(25);
  }
  throw new Error("Owned capture fixture did not become ready");
};

const isRunning = async (pid: number): Promise<boolean> => {
  try {
    const { stdout } = await exec("ps", ["-o", "stat=", "-p", String(pid)]);
    return stdout.trim().length > 0 && !stdout.trim().startsWith("Z");
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === 1)
      return false;
    throw cause;
  }
};

const waitForExit = async (pid: number): Promise<void> => {
  await expect
    .poll(() => isRunning(pid), { timeout: 3_000, interval: 25 })
    .toBe(false);
};

const cleanupFixture = async (marker: Marker | undefined): Promise<void> => {
  if (marker === undefined) return;
  // Teardown uses the fixture's capture run token, never a bare PID kill.
  await cleanupOwnedProcessGroup({
    runId: marker.runId,
    leaderPid: marker.rootPid,
    processGroupId: marker.rootPid,
  });
};

itWithCaptureCapability.each(["SIGINT", "SIGTERM"] as const)(
  "awaits owned capture service cleanup and emits a typed command cancellation after %s",
  async (signal) => {
    const root = await createTestTempDirectory("rea-process-cli-cancel-");
    const scenario = join(root, "scenario.json");
    await writeFile(
      scenario,
      JSON.stringify({
        executable: process.execPath,
        arguments: [fixture, "active", root],
        working_directory: root,
        timeout_ms: 15_000,
        idle_timeout_ms: 15_000,
      }),
    );
    const cli = spawn(
      process.execPath,
      ["--input-type=module", "--eval", commandWorker(scenario)],
      { cwd: root, env: {}, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    cli.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    cli.stderr.resume();
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve, reject) => {
      cli.once("error", reject);
      cli.once("close", (code, exitSignal) =>
        resolve({ code, signal: exitSignal }),
      );
    });
    let marker: Marker | undefined;
    onTestFinished(async () => {
      await cleanupFixture(marker);
      if (cli.exitCode === null && cli.signalCode === null) cli.kill("SIGKILL");
      await closed;
    });
    marker = await readMarker(root);
    expect(await isRunning(marker.rootPid)).toBe(true);
    cli.kill(signal);
    expect(await closed).toEqual({
      code: signal === "SIGINT" ? 130 : 143,
      signal: null,
    });
    await waitForExit(marker.rootPid);
    await expect(access(join(root, "late-write"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    const result = analysisCliErrorEnvelopeSchema.parse(JSON.parse(stdout));
    expect(result, JSON.stringify(result.details)).toMatchObject({
      code: "cancelled",
      details: { operation: "process_capture", cleanup: "complete" },
    });
  },
  20_000,
);

itWithCaptureCapability(
  "stops the owned descendant when the direct capture service is cancelled during post-exit settlement",
  async () => {
    const root = await createTestTempDirectory(
      "rea-process-mcp-settle-cancel-",
    );
    const completed = createDeferred<string>();
    const completionSchema = z.object({
      tool: z.string(),
      status: z.string(),
      msg: z.string(),
    });
    const logger = pino(
      { level: "info" },
      {
        write(line) {
          const parsed = completionSchema.safeParse(JSON.parse(line));
          if (
            parsed.success &&
            parsed.data.tool === "capture_process_scenario" &&
            parsed.data.msg === "MCP tool execution completed"
          )
            completed.resolve(parsed.data.status);
        },
      },
    );
    const resourceScope = new ProcessCaptureResourceScope();
    let marker: Marker | undefined;
    onTestFinished(async () => {
      await cleanupFixture(marker);
      await resourceScope.close();
    });
    const controller = new AbortController();
    const scenario = processScenarioSchema.parse({
      executable: process.execPath,
      arguments: [fixture, "settlement", root],
      working_directory: root,
      timeout_ms: 15_000,
      idle_timeout_ms: 15_000,
      settle_ms: 10_000,
    });
    const call = logToolExecution(logger, "capture_process_scenario", () =>
      captureProcessScenario(
        scenario,
        controller.signal,
        process.platform,
        {},
        undefined,
        undefined,
        undefined,
        resourceScope,
      ),
    );
    marker = await Promise.race([
      readMarker(root),
      call.then(() => {
        throw new Error("Owned capture completed before its readiness marker");
      }),
    ]);
    if (marker.childPid === undefined)
      throw new Error("Settlement fixture did not report its descendant");
    await waitForExit(marker.rootPid);
    expect(await isRunning(marker.childPid)).toBe(true);
    // The root has exited while the descendant keeps its owned group alive.
    await delay(100);
    controller.abort(new Error("cancel settlement fixture"));
    const cancelled = await call;
    expect(cancelled.ok).toBe(false);
    if (cancelled.ok) throw new Error("Owned capture ignored cancellation");
    expect(cancelled.error).toMatchObject({
      reason: "cancelled",
      cleanupIncomplete: false,
    });
    await waitForExit(marker.childPid);
    expect(await completed.promise).toBe("error");
    await expect(access(join(root, "late-write"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await resourceScope.close();
  },
  20_000,
);

processTest(
  "public CLI and MCP deny the advanced fixture before any workload starts",
  async ({ processes }) => {
    const root = await createTestTempDirectory("rea-process-public-denial-");
    const scenario = processScenarioSchema.parse({
      executable: process.execPath,
      arguments: [fixture, "settlement", root],
      working_directory: root,
    });
    const path = join(root, "scenario.json");
    await writeFile(path, JSON.stringify(scenario));
    const cli = await processes.run(
      process.execPath,
      ["scripts/rea.mjs", "capture-process", path, "--json"],
      { env: { REA_LOG_LEVEL: "silent" }, timeoutMs: 10000 },
    );
    expect(cli.exitCode).toBe(1);
    expect(JSON.parse(cli.stdout)).toMatchObject({
      code: "capability_unavailable",
    });
    const session = createTestBinarySession(() => {
      throw new Error("Denied capture must not launch a provider");
    });
    const server = createServer(
      { kind: "session", session },
      { logger: pino({ level: "silent" }) },
    );
    const client = new Client({ name: "capture-public-denial", version: "1" });
    onTestFinished(async () => {
      await client.close();
      await server.close();
      await session.close();
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    // Denial is a successful MCP response carrying a typed tool error, not a
    // cancelled client promise. Assert the actual response immediately.
    const denied = await client.callTool({
      name: "capture_process_scenario",
      arguments: scenario,
    });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain("capability_unavailable");
    await expect(access(join(root, "ready.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(join(root, "late-write"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await client.ping();
  },
);
