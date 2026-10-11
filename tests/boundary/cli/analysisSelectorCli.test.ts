import { describe, expect } from "vitest";

import { cliTest } from "../../support/cli/cliFixture.js";
import { serveRegisteredCliFixture } from "../../support/cli/registeredCliFixture.js";
import { registerCoreBinaryCommands } from "../../../src/cli/coreBinaryCommands.js";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { silentLogger } from "../../../src/logger.js";

const runSelectorFixture = async (argv: readonly string[]) => {
  const acquisitions: string[] = [];
  const result = await serveRegisteredCliFixture((cli) => {
    registerCoreBinaryCommands(cli, silentLogger, async (path) => {
      if (path !== "does-not-exist")
        throw new Error(
          "Only the declared missing synthetic target may be parsed",
        );
      acquisitions.push(path);
      const target = await parseBinaryTarget(path);
      if (!target.ok) throw target.error;
      throw new Error("No existing target may reach this parser fixture");
    });
  }, argv);
  return { ...result, acquisitions };
};

const selectors = [
  ["function", "procedure", "analyze_function"],
  ["instructions", "procedure", "read_function_instructions"],
  ["decompile", "procedure", "procedure_pseudo_code"],
  ["xrefs", "address", "xrefs"],
  ["search", "pattern", "search_strings"],
  ["trace", "query", "trace_feature"],
] as const;

describe("CLI analysis selector boundaries", () => {
  cliTest(
    "rejects missing and conflicting selectors before opening a target",
    async ({ cli }) => {
      for (const [command, option, operation] of selectors) {
        for (const [selection, reason] of [
          [[], "missing_argument"],
          [["first", `--${option}=-second`], "invalid_value"],
        ] as const) {
          const arguments_ = [
            command,
            "does-not-exist",
            ...selection,
            "--format",
            "json",
          ];
          const denied = await cli.run({
            arguments: [
              command,
              "does-not-exist",
              ...selection,
              "--format",
              "json",
            ],
            environment: { REA_LOG_LEVEL: "silent" },
          });
          expect(denied.exitCode).not.toBe(0);
          expect(denied.json).toMatchObject({ code: "capability_unavailable" });
          const result = await runSelectorFixture(arguments_);
          expect(result.acquisitions).toEqual([]);
          expect(result.exitCode).not.toBe(0);
          expect(result.json).toMatchObject({
            code: "invalid_request",
            details: { operation, issues: [{ path: [option], reason }] },
          });
        }
      }
    },
  );

  cliTest(
    "keeps named dash values out of global-option parsing",
    async ({ cli }) => {
      for (const [command, option] of selectors) {
        const denied = await cli.run({
          arguments: [
            command,
            "does-not-exist",
            `--${option}=--help`,
            "--format",
            "json",
          ],
          environment: { REA_LOG_LEVEL: "silent" },
        });
        expect(denied.exitCode).not.toBe(0);
        expect(denied.json).toMatchObject({ code: "capability_unavailable" });
        const result = await runSelectorFixture([
          command,
          "does-not-exist",
          `--${option}=--help`,
          "--format",
          "json",
        ]);
        expect(result.acquisitions).toEqual(["does-not-exist"]);
        expect(result.exitCode).not.toBe(0);
        expect(result.json).toMatchObject({ code: "target_unavailable" });
      }
    },
  );
});
