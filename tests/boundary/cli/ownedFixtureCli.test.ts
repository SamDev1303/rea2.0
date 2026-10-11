import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { describe, expect, vi } from "vitest";

import { ownedCliBootstrapPath } from "../../../scripts/fixtures/owned-cli-bootstrap.mjs";
import { processScenarioSchema } from "../../../src/domain/process/processScenario.js";
import {
  digestOwnedFixtureInput,
  type OwnedFixturePolicyData,
} from "../../../src/application/investigationSafety/OwnedFixturePolicy.js";
import * as runtimeScope from "../../../src/application/investigationSafety/OwnedFixturePolicyRuntime.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { processTest } from "../../support/process/processFixture.js";
import { runOwnedCliFixture } from "../../support/investigation/ownedCliFixture.js";

const fileIdentity = async (
  path: string,
  role: "executable" | "scenario" | "dependency",
) => ({
  path: await realpath(path),
  sha256: createHash("sha256")
    .update(await readFile(path))
    .digest("hex"),
  role,
});

const processPolicy = async (
  root: string,
): Promise<{ policy: OwnedFixturePolicyData; scenario: string }> => {
  const program = join(root, "synthetic.mjs");
  const scenario = join(root, "scenario.json");
  const executable = await realpath(process.execPath);
  await writeFile(
    program,
    'process.stdout.write("OWNED_FIXTURE_OK;ambient=" + String(Object.hasOwn(process.env, "REA2_SYNTHETIC_SECRET")) + "\\n");',
  );
  await writeFile(
    scenario,
    JSON.stringify(
      processScenarioSchema.parse({
        executable,
        arguments: [program],
        working_directory: root,
        timeout_ms: 1000,
      }),
    ),
  );
  return {
    scenario,
    policy: {
      roots: [await realpath(root)],
      files: [
        await fileIdentity(executable, "executable"),
        await fileIdentity(program, "dependency"),
        await fileIdentity(scenario, "scenario"),
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

describe("compiled owned fixture controller", () => {
  processTest(
    "refuses startup directories outside its sealed roots before launching a child",
    async ({ processes }) => {
      const root = await createTestTempDirectory("rea2-owned-cwd-");
      const outside = await createTestTempDirectory("rea2-unowned-cwd-");
      const { policy, scenario } = await processPolicy(root);
      const alias = join(root, "alias");
      const nested = join(root, "nested");
      await mkdir(nested);
      await symlink(nested, alias, "dir");
      const spawn = vi
        .spyOn(processes, "runWithControllerData")
        .mockResolvedValue({
          exitCode: 0,
          signal: null,
          stdout: "{}",
          stderr: "SYNTHETIC_CHILD_LAUNCH_MARKER",
        });
      try {
        for (const cwd of [outside, alias, join(homedir(), ".codex")])
          await expect(
            runOwnedCliFixture(processes, {
              policy,
              arguments: ["capture-process", scenario, "--json"],
              cwd,
            }),
          ).rejects.toThrow();
        await expect(
          runOwnedCliFixture(processes, {
            policy: { ...policy, roots: [join(homedir(), ".codex")] },
            arguments: ["capture-process", scenario, "--json"],
          }),
        ).rejects.toThrow();
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        spawn.mockRestore();
      }
    },
  );

  processTest(
    "pins an omitted cwd to its first owned root and permits a canonical owned child",
    async ({ processes }) => {
      const root = await createTestTempDirectory("rea2-owned-cwd-default-");
      const { policy, scenario } = await processPolicy(root);
      const nested = join(root, "nested");
      await mkdir(nested);
      const spawn = vi
        .spyOn(processes, "runWithControllerData")
        .mockResolvedValue({
          exitCode: 0,
          signal: null,
          stdout: "{}",
          stderr: "",
        });
      try {
        for (const cwd of [undefined, nested]) {
          await runOwnedCliFixture(processes, {
            policy,
            arguments: ["capture-process", scenario, "--json"],
            ...(cwd === undefined ? {} : { cwd }),
          });
          const call = spawn.mock.calls.at(-1)!;
          const envelope = JSON.parse(call[2]);
          expect(call[3]?.cwd).toBe(cwd ?? root);
          expect(envelope.startup_cwd).toEqual({
            ...(await runtimeScope.identifyOwnedFixtureDirectory(cwd ?? root)),
            root: await runtimeScope.identifyOwnedFixtureDirectory(root),
          });
        }
      } finally {
        spawn.mockRestore();
      }
    },
  );

  processTest(
    "rechecks the bound directory identity before handing data to a child",
    async ({ processes }) => {
      const root = await createTestTempDirectory("rea2-owned-cwd-recheck-");
      const { policy, scenario } = await processPolicy(root);
      const identify = runtimeScope.identifyOwnedFixtureDirectory;
      let calls = 0;
      const directory = vi
        .spyOn(runtimeScope, "identifyOwnedFixtureDirectory")
        .mockImplementation(async (path) => {
          const identity = await identify(path);
          calls += 1;
          return calls === 3
            ? { ...identity, ino: identity.ino + 1 }
            : identity;
        });
      const spawn = vi
        .spyOn(processes, "runWithControllerData")
        .mockResolvedValue({
          exitCode: 0,
          signal: null,
          stdout: "{}",
          stderr: "SYNTHETIC_CHILD_LAUNCH_MARKER",
        });
      try {
        await expect(
          runOwnedCliFixture(processes, {
            policy,
            arguments: ["capture-process", scenario, "--json"],
          }),
        ).rejects.toThrow("startup directory changed");
        expect(spawn).not.toHaveBeenCalled();
      } finally {
        directory.mockRestore();
        spawn.mockRestore();
      }
    },
  );
});

describe("private compiled fixture bootstrap", () => {
  processTest(
    "refuses a child cwd or identity that disagrees with its private sealed envelope",
    async ({ processes }) => {
      const root = await createTestTempDirectory("rea2-owned-cwd-bootstrap-");
      const outside = await createTestTempDirectory(
        "rea2-unowned-cwd-bootstrap-",
      );
      const { policy, scenario } = await processPolicy(root);
      const identity = await runtimeScope.identifyOwnedFixtureDirectory(root);
      for (const [cwd, startup] of [
        [outside, identity],
        [root, { ...identity, ino: identity.ino + 1 }],
      ] as const) {
        const result = await processes.runWithControllerData(
          process.execPath,
          [ownedCliBootstrapPath],
          JSON.stringify({
            policy,
            arguments: ["capture-process", scenario, "--json"],
            startup_cwd: { ...startup, root: identity },
          }),
          { env: { REA_LOG_LEVEL: "silent" }, cwd, timeoutMs: 10000 },
        );
        expect(result.exitCode).toBe(1);
        expect(result.signal).toBeNull();
        expect(result.stderr).toContain("bootstrap refused");
        expect(result.stdout).toBe("");
      }
    },
  );

  processTest(
    "requires a private controller pipe on its separate bootstrap",
    async ({ processes }) => {
      const result = await processes.run(
        process.execPath,
        [ownedCliBootstrapPath],
        { env: {}, timeoutMs: 10000 },
      );
      expect(result.exitCode).toBe(1);
      expect(result.signal).toBeNull();
      expect(result.stderr).toContain("bootstrap refused");
    },
  );

  processTest(
    "refuses malformed or oversized private controller data",
    async ({ processes }) => {
      const result = await processes.runWithControllerData(
        process.execPath,
        [ownedCliBootstrapPath],
        "{}",
        { env: {}, timeoutMs: 10000 },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("bootstrap refused");
      await expect(
        processes.runWithControllerData(
          process.execPath,
          [ownedCliBootstrapPath],
          "x".repeat(1024 * 1024 + 1),
          { env: {}, timeoutMs: 10000 },
        ),
      ).rejects.toThrow("byte budget");
    },
  );

  processTest(
    "captures only a sealed synthetic process without inheriting ambient credentials",
    async ({ processes }) => {
      const root = await createTestTempDirectory("rea2-owned-cli-");
      const { policy, scenario } = await processPolicy(root);
      vi.stubEnv("REA2_SYNTHETIC_SECRET", "SYNTHETIC_SENTINEL");
      try {
        const result = await runOwnedCliFixture(processes, {
          policy,
          arguments: ["capture-process", scenario, "--json"],
        });
        expect(result.exitCode).toBe(0);
        expect(result.json).toMatchObject({
          operation: "capture_process_scenario",
        });
        expect(result.stdout).toContain("OWNED_FIXTURE_OK;ambient=false");
        const changed = join(root, "unsealed-scenario.json");
        await writeFile(changed, await readFile(scenario));
        const refused = await runOwnedCliFixture(processes, {
          policy,
          arguments: ["capture-process", changed, "--json"],
        });
        expect(refused.exitCode).toBe(1);
        expect(refused.stdout).toContain("capability_unavailable");
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  processTest(
    "rejects loader injection and changed sealed bytes before spawning the bootstrap",
    async ({ processes }) => {
      const root = await createTestTempDirectory("rea2-owned-cli-refusal-");
      const { policy, scenario } = await processPolicy(root);
      await expect(
        runOwnedCliFixture(processes, {
          policy: {
            ...policy,
            environment: [
              { name: "NODE_OPTIONS", value: "--require /unreviewed-hook.cjs" },
            ],
          },
          arguments: ["capture-process", scenario, "--json"],
        }),
      ).rejects.toThrow(
        "No matching sealed controller-owned fixture capability",
      );
      await writeFile(
        scenario,
        "changed after the controller sealed its expected checksum",
      );
      await expect(
        runOwnedCliFixture(processes, {
          policy,
          arguments: ["capture-process", scenario, "--json"],
        }),
      ).rejects.toThrow(
        "No matching sealed controller-owned fixture capability",
      );
    },
  );
});
