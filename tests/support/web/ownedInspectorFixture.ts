import { createHash } from "node:crypto";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import type { TestProcesses } from "../process/processFixture.js";

const fixtureName = "probe #百分比 %.cjs";
const fixtureSource = "setInterval(() => {}, 25);\n";
const bootstrapUrl = new URL("./ownedInspectorBootstrap.mjs", import.meta.url);
const identity = async (path: string) => {
  const canonical = await realpath(path);
  const metadata = await lstat(canonical);
  if (canonical !== path || !metadata.isFile() || metadata.nlink !== 1)
    throw new Error("Owned Inspector file is not a regular canonical file");
  return {
    path,
    dev: metadata.dev,
    ino: metadata.ino,
    sha256: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  };
};

/** Fixed authored timer and actual loopback Inspector, never caller code or flags. */
export const startOwnedInspectorFixture = async (processes: TestProcesses) => {
  const cwd = await realpath(
    await createTestTempDirectory("rea-live-inspector-"),
  );
  const fixture = join(cwd, fixtureName);
  await writeFile(fixture, fixtureSource, { flag: "wx", mode: 0o600 });
  const node = await identity(await realpath(process.execPath));
  const bootstrap = await identity(fileURLToPath(bootstrapUrl));
  const timer = await identity(fixture);
  const directory = await lstat(cwd);
  const child = processes.spawnWithControllerData(
    node.path,
    ["--inspect=127.0.0.1:0", bootstrap.path],
    JSON.stringify({
      cwd: { path: cwd, dev: directory.dev, ino: directory.ino },
      node,
      bootstrap,
      timer,
    }),
    { cwd, env: {} },
  );
  let stderr = "";
  let markReady!: () => void;
  let failReady!: (cause: Error) => void;
  const readiness = new Promise<void>((resolve, reject) => {
    markReady = resolve;
    failReady = reject;
  });
  let outputBytes = 0;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let termination: Promise<void> | undefined;
  const terminateOnce = async () => {
    if (
      child.pid === undefined ||
      child.exitCode !== null ||
      child.signalCode !== null
    )
      return;
    const closed = new Promise<void>((resolve) =>
      child.once("close", () => resolve()),
    );
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
    killTimer.unref();
    await closed;
    clearTimeout(killTimer);
  };
  const terminate = () => (termination ??= terminateOnce());
  const requestTermination = () => {
    void terminate().catch(() => child.kill("SIGKILL"));
  };
  const deadline = setTimeout(requestTermination, 30_000);
  deadline.unref();
  const readyDeadline = setTimeout(() => {
    failReady(
      new Error("Owned Inspector fixture did not finish controller validation"),
    );
    requestTermination();
  }, 10_000);
  readyDeadline.unref();
  child.stdout.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes > 128 * 1024) requestTermination();
  });
  child.stderr.on("data", (chunk: Buffer) => {
    outputBytes += chunk.length;
    if (outputBytes <= 128 * 1024) {
      stderr += chunk.toString();
      if (stderr.includes("Owned Inspector fixture ready.\n")) {
        clearTimeout(readyDeadline);
        markReady();
      }
    } else requestTermination();
  });
  child.on("error", () => {
    failReady(new Error("Owned Inspector fixture startup failed"));
    if (child.pid === undefined) {
      clearTimeout(readyDeadline);
      clearTimeout(deadline);
      clearTimeout(killTimer);
    } else requestTermination();
  });
  child.once("close", () => {
    failReady(
      new Error(`Owned Inspector fixture closed before readiness: ${stderr}`),
    );
    clearTimeout(readyDeadline);
    clearTimeout(deadline);
    clearTimeout(killTimer);
  });
  await readiness;
  return { child, fixture, stderr: () => stderr, terminate };
};
