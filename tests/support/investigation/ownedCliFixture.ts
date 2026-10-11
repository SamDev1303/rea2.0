import { ownedCliBootstrapPath } from "../../../scripts/fixtures/owned-cli-bootstrap.mjs";
import {
  sealOwnedFixturePolicy,
  snapshotOwnedFixtureInput,
  type OwnedFixturePolicyData,
} from "../../../src/application/investigationSafety/OwnedFixturePolicy.js";
import {
  identifyOwnedFixtureDirectory,
  withinOwnedFixtureRoot,
} from "../../../src/application/investigationSafety/OwnedFixturePolicyRuntime.js";
import type { CliResult } from "../cli/cliFixture.js";
import type { TestProcesses } from "../process/processFixture.js";
import { createOwnedAppleStaticSession } from "../../../src/composition/OwnedAppleStaticSession.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** Predeclared exact authority is separate from the synthetic target invocation. */
export interface OwnedCliFixtureInvocation {
  readonly policy: OwnedFixturePolicyData;
  readonly arguments: readonly string[];
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

/** Use the compiled handlers with sealed fixture data and no inherited credentials. */
const prepareOwnedCliLaunch = async (invocation: OwnedCliFixtureInvocation) => {
  // Snapshot bounded plain data before the first await; callers cannot alter the
  // child environment or grants while file identities are being verified.
  const snapshot = snapshotOwnedFixtureInput(invocation);
  const policy = snapshot.policy;
  const arguments_ = snapshot.arguments;
  const startupPath = snapshot.cwd ?? policy.roots[0];
  const rootPath = policy.roots.find(
    (root) =>
      startupPath !== undefined && withinOwnedFixtureRoot(root, startupPath),
  );
  if (startupPath === undefined || rootPath === undefined)
    throw new Error(
      "The child startup directory requires a sealed fixture root",
    );
  const root = await identifyOwnedFixtureDirectory(rootPath);
  const startup = await identifyOwnedFixtureDirectory(startupPath);
  // Refuse loader variables and changed fixture bytes before Node consumes any env.
  const controller = policy.grants.some(({ mode }) => mode === "owned-static")
    ? createOwnedAppleStaticSession()
    : undefined;
  await sealOwnedFixturePolicy(
    policy,
    controller === undefined
      ? undefined
      : {
          owned_static_ports: [
            {
              port_id: "controller-owned-apple-static-port",
              reference: controller,
            },
          ],
        },
  );
  const environment = Object.fromEntries(
    policy.environment.map(({ name, value }) => [name, value]),
  );
  // Bind both the containing root and cwd across asynchronous policy validation.
  // A path-based spawn still cannot provide descriptor-relative race immunity.
  for (const expected of [root, startup]) {
    const current = await identifyOwnedFixtureDirectory(expected.path);
    if (current.dev !== expected.dev || current.ino !== expected.ino)
      throw new Error(
        "The child startup directory changed during verification",
      );
  }
  return {
    controllerData: JSON.stringify({
      policy,
      arguments: arguments_,
      startup_cwd: { ...startup, root },
    }),
    options: {
      env: environment,
      cwd: startup.path,
      timeoutMs: snapshot.timeoutMs ?? 10000,
    },
  };
};

/** Live private controller route, preserving pre-spawn seal and cwd checks. */
export const spawnOwnedCliFixture = async (
  processes: TestProcesses,
  invocation: OwnedCliFixtureInvocation,
): Promise<ChildProcessWithoutNullStreams> => {
  const prepared = await prepareOwnedCliLaunch(invocation);
  const child = processes.spawnWithControllerData(
    process.execPath,
    [ownedCliBootstrapPath],
    prepared.controllerData,
    { env: prepared.options.env, cwd: prepared.options.cwd },
  );
  let killDeadline: ReturnType<typeof setTimeout> | undefined;
  const deadline = setTimeout(() => {
    child.kill("SIGTERM");
    killDeadline = setTimeout(() => child.kill("SIGKILL"), 1000);
    killDeadline.unref();
  }, prepared.options.timeoutMs);
  deadline.unref();
  child.once("close", () => {
    clearTimeout(deadline);
    clearTimeout(killDeadline);
  });
  return child;
};

/** Use the compiled handlers with sealed fixture data and no inherited credentials. */
export const runOwnedCliFixture = async (
  processes: TestProcesses,
  invocation: OwnedCliFixtureInvocation,
): Promise<CliResult> => {
  const prepared = await prepareOwnedCliLaunch(invocation);
  const result = await processes.runWithControllerData(
    process.execPath,
    [ownedCliBootstrapPath],
    prepared.controllerData,
    prepared.options,
  );
  let json: unknown;
  try {
    json = JSON.parse(result.stdout);
  } catch {
    json = undefined;
  }
  return { ...result, json };
};
