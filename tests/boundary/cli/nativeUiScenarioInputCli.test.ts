import { describe, expect } from "vitest";

import { cliTest } from "../../support/cli/cliFixture.js";
import { serveRegisteredCliFixture } from "../../support/cli/registeredCliFixture.js";
import { registerUtilityCommands } from "../../../src/cli/utilityCommands.js";
import { silentLogger } from "../../../src/logger.js";
import type { TestCli } from "../../support/cli/cliFixture.js";

const runCapture = async (cli: TestCli, steps: string | undefined) => {
  const arguments_ = [
    "capture-native-ui-scenario",
    "/provider-must-not-be-invoked",
    "--pid",
    "1",
    "--window-id",
    "1",
  ];
  if (steps !== undefined) arguments_.push("--steps", steps);
  arguments_.push("--json");
  const denied = await cli.run({
    arguments: arguments_,
    environment: { REA_LOG_LEVEL: "silent" },
  });
  expect(denied.exitCode).not.toBe(0);
  expect(denied.json).toMatchObject({ code: "capability_unavailable" });
  let acquisitions = 0;
  const result = await serveRegisteredCliFixture((fixture) => {
    registerUtilityCommands(
      fixture,
      silentLogger,
      {},
      {
        runSessionStatus: async () => {
          acquisitions++;
          throw new Error("Status acquisition forbidden");
        },
        runProviderAnalysis: async () => {
          acquisitions++;
          throw new Error("Native acquisition forbidden");
        },
      },
    );
  }, arguments_);
  expect(acquisitions).toBe(0);
  return result;
};

describe("native UI scenario CLI input", () => {
  cliTest(
    "rejects omitted steps under the shared scenario contract",
    async ({ cli }) => {
      const result = await runCapture(cli, undefined);

      expect(result.exitCode).not.toBe(0);
      expect(result.json).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "capture_native_ui_scenario",
          issues: [{ path: ["steps"], reason: "missing_argument" }],
        },
      });
    },
  );

  cliTest("rejects malformed JSON as invalid input", async ({ cli }) => {
    const result = await runCapture(cli, "[");

    expect(result.exitCode).not.toBe(0);
    expect(result.json).toMatchObject({
      code: "invalid_request",
      details: {
        operation: "capture_native_ui_scenario",
        issues: [
          {
            path: ["steps"],
            reason: "invalid_format",
            expected: "JSON",
          },
        ],
      },
    });
  });

  cliTest(
    "requires at least one schema-valid scenario step",
    async ({ cli }) => {
      const result = await runCapture(cli, "[]");

      expect(result.exitCode).not.toBe(0);
      expect(result.json).toMatchObject({
        code: "invalid_request",
        details: {
          operation: "capture_native_ui_scenario",
          issues: [{ path: ["steps"], reason: "out_of_range", minimum: 1 }],
        },
      });
    },
  );
});
