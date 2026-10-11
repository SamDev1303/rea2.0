import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { processScenarioSchema } from "../../../src/domain/process/processScenario.js";
import {
  attachOwnedFixturePolicy,
  digestOwnedFixtureInput,
  sealOwnedFixturePolicy,
  type OwnedFixturePolicyData,
} from "../../../src/application/investigationSafety/OwnedFixturePolicy.js";
import { verifyOwnedNodeFixtureScript } from "../../../src/application/investigationSafety/OwnedNodeFixtureProfile.js";
import { identifyOwnedFixtureDirectory } from "../../../src/application/investigationSafety/OwnedFixturePolicyRuntime.js";

const identifyFile = async (
  path: string,
  role: "executable" | "scenario" | "dependency",
) => ({
  path: await realpath(path),
  sha256: createHash("sha256")
    .update(await readFile(path))
    .digest("hex"),
  role,
});

/** Accept only an explicitly authored expression fixture, never target-derived code. */
export const prepareOwnedProcessCliFixture = async (selected: {
  readonly root: string;
  readonly source: string;
  readonly scenarioFileName: string;
}): Promise<{
  readonly scenario: string;
  readonly policy: OwnedFixturePolicyData;
}> => {
  const { root: rootPath, source, scenarioFileName } = selected;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/u.test(scenarioFileName))
    throw new Error("The owned scenario requires a plain JSON file name");
  verifyOwnedNodeFixtureScript(source);
  const root = (await identifyOwnedFixtureDirectory(rootPath)).path;
  const executable = await realpath(process.execPath);
  const program = join(root, "owned-process.mjs");
  const scenario = join(root, scenarioFileName);
  await writeFile(program, source, { flag: "wx" });
  await writeFile(
    scenario,
    JSON.stringify(
      processScenarioSchema.parse({
        executable,
        arguments: [program],
        working_directory: root,
      }),
    ),
    { flag: "wx" },
  );
  return {
    scenario,
    policy: {
      roots: [root],
      files: [
        await identifyFile(executable, "executable"),
        await identifyFile(program, "dependency"),
        await identifyFile(scenario, "scenario"),
      ],
      endpoints: [],
      environment: [{ name: "REA_LOG_LEVEL", value: "silent" }],
      available_capabilities: ["owned-synthetic-process-capture"],
      grants: [
        {
          operation: "capture-process",
          input_digest: digestOwnedFixtureInput({
            args: { scenario },
            options: {},
          }),
          capability: "owned-synthetic-process-capture",
          mode: "owned-files",
        },
      ],
    },
  };
};

/** Strict MCP sibling; the recording session cannot grant process execution. */
export const prepareOwnedProcessMcpFixture = async (selected: {
  readonly root: string;
  readonly source: string;
}) => {
  const { root: rootPath, source } = selected;
  verifyOwnedNodeFixtureScript(source);
  const root = (await identifyOwnedFixtureDirectory(rootPath)).path;
  const executable = await realpath(process.execPath);
  const program = join(root, "owned-process.mjs");
  await writeFile(program, source, { flag: "wx" });
  const input = processScenarioSchema.parse({
    executable,
    arguments: [program],
    working_directory: root,
  });
  const capability = "owned-synthetic-process-capture";
  const policy: OwnedFixturePolicyData = {
    roots: [root],
    files: [
      await identifyFile(executable, "executable"),
      await identifyFile(program, "dependency"),
    ],
    endpoints: [],
    environment: [],
    available_capabilities: [capability],
    grants: [
      {
        operation: "capture_process_scenario",
        input_digest: digestOwnedFixtureInput(input),
        capability,
        mode: "owned-files",
      },
    ],
  };
  return { input, policy };
};

/** Predeclared exact capture input, attached before receiving MCP requests. */
export const attachOwnedProcessMcpFixture = async (
  server: object,
  fixture: Awaited<ReturnType<typeof prepareOwnedProcessMcpFixture>>,
): Promise<void> => {
  const token = await sealOwnedFixturePolicy(fixture.policy);
  attachOwnedFixturePolicy(server, token);
};
