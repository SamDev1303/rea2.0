import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  attachOwnedFixturePolicy,
  digestOwnedFixtureInput,
  sealOwnedFixturePolicy,
  type OwnedFixturePolicyData,
} from "../../../src/application/investigationSafety/OwnedFixturePolicy.js";
import {
  OWNED_TIMED_FIXTURE_CAPABILITY,
  OWNED_TIMED_FIXTURE_HEAP_ARGUMENT,
} from "../../../src/application/investigationSafety/OwnedFixturePolicyData.js";
import { verifyOwnedTimedNodeFixtureScript } from "../../../src/application/investigationSafety/OwnedTimedNodeFixtureProfile.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/** Explicit controller-authored input, fixed before a server or target receives it. */
export const prepareOwnedTimedProcessFixture = async (selected: {
  readonly source: string;
  readonly adapter: "cli" | "mcp";
  readonly timeoutMs: number;
  readonly idleTimeoutMs: number;
}) => {
  const { source, adapter, timeoutMs, idleTimeoutMs } = selected;
  verifyOwnedTimedNodeFixtureScript(source);
  const root = await createTestTempDirectory("rea-owned-timed-progress-");
  const executable = await realpath(process.execPath);
  const script = join(root, "owned-timed.mjs");
  const scenario = join(root, "scenario.json");
  await writeFile(script, source, { flag: "wx" });
  const input = toolContract("capture_process_scenario").inputSchema.parse({
    executable,
    arguments: [OWNED_TIMED_FIXTURE_HEAP_ARGUMENT, script],
    working_directory: root,
    timeout_ms: timeoutMs,
    idle_timeout_ms: idleTimeoutMs,
  });
  if (adapter === "cli")
    await writeFile(scenario, JSON.stringify(input), { flag: "wx" });
  const files = [
    {
      path: executable,
      sha256: createHash("sha256")
        .update(await readFile(executable))
        .digest("hex"),
      role: "executable" as const,
    },
    {
      path: script,
      sha256: createHash("sha256").update(source).digest("hex"),
      role: "dependency" as const,
    },
  ];
  const policy: OwnedFixturePolicyData = {
    roots: [root],
    files:
      adapter === "cli"
        ? [
            ...files,
            {
              path: scenario,
              sha256: createHash("sha256")
                .update(await readFile(scenario))
                .digest("hex"),
              role: "scenario",
            },
          ]
        : files,
    endpoints: [],
    environment: [],
    available_capabilities: [OWNED_TIMED_FIXTURE_CAPABILITY],
    grants: [
      {
        operation:
          adapter === "cli" ? "capture-process" : "capture_process_scenario",
        input_digest: digestOwnedFixtureInput(
          adapter === "cli" ? { args: { scenario }, options: {} } : input,
        ),
        capability: OWNED_TIMED_FIXTURE_CAPABILITY,
        mode: "owned-files",
      },
    ],
  };
  return { root, scenario, input, policy };
};

/** Attach only predeclared fixture data; never derive authority from a live request. */
export const attachOwnedTimedMcpFixture = async (
  server: object,
  fixture: Awaited<ReturnType<typeof prepareOwnedTimedProcessFixture>>,
): Promise<void> => {
  const token = await sealOwnedFixturePolicy(fixture.policy);
  attachOwnedFixturePolicy(server, token);
};
