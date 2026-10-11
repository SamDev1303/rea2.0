import { Cli } from "incur";
import { describe, expect, it } from "vitest";

import { createCli } from "../../../src/cli.js";
import { serveRegisteredCliFixture } from "../../support/cli/registeredCliFixture.js";
import { registerUtilityCommands } from "../../../src/cli/utilityCommands.js";
import { silentLogger } from "../../../src/logger.js";
import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import { createCliInventory } from "../../../scripts/lib/catalog-cli.mjs";

type CliInstance = ReturnType<typeof createCli>;
type CommandMap = NonNullable<ReturnType<typeof Cli.toCommands.get>>;

const registeredCommands: WeakMap<object, CommandMap> = Cli.toCommands;

const serve = async (
  cli: CliInstance,
  argv: readonly string[],
): Promise<{ readonly stdout: string; readonly exitCode: number }> => {
  let stdout = "";
  let exitCode = 0;
  await cli.serve([...argv], {
    env: {},
    exit: (code) => {
      exitCode = code;
    },
    stdout: (text) => {
      stdout += text;
    },
  });
  return { stdout, exitCode };
};

const registeredAliases = (
  cli: CliInstance,
  command: string,
): Record<string, unknown> => {
  const entry = registeredCommands.get(cli)?.get(command);
  const alias: unknown =
    entry === undefined ? undefined : Reflect.get(entry, "alias");
  return typeof alias === "object" && alias !== null ? { ...alias } : {};
};

describe("CLI option aliases", () => {
  it("register only single-character short flags", async () => {
    const cli = createCli({});
    const invalid: string[] = [];
    const undescribed: string[] = [];
    for (const command of createCliInventory(cli).primary) {
      for (const [option, short] of Object.entries(
        registeredAliases(cli, command),
      ))
        if (typeof short !== "string" || short.length !== 1)
          invalid.push(`${command} ${option}: ${String(short)}`);
      // Incur parses `-abc` as stacked one-letter flags, so help must never
      // advertise a multi-letter single-dash spelling.
      const help = await serve(cli, [command, "--help"]);
      for (const match of help.stdout.matchAll(/(?:^|[\s,])-([a-z][\w-]+)/gmu))
        invalid.push(`${command} help: -${match[1] ?? ""}`);
      const options = /^Options:\n((?: {2}.*\n?)*)/mu.exec(help.stdout)?.[1];
      for (const line of options?.split("\n") ?? [])
        if (/^ {2}--\S+(?: <[^>]+>)?\s*$/u.test(line))
          undescribed.push(`${command} ${line.trim()}`);
    }
    expect(invalid).toEqual([]);
    expect(undescribed).toEqual([]);
  });

  it("accepts kebab-case long options without registered aliases", async () => {
    const cli = createCli({});
    const result = await serve(cli, [
      "inspect-plist",
      "/nonexistent/REA.app",
      "--relative-path",
      "Contents/Info.plist",
      "--json",
    ]);
    expect(result.stdout).not.toContain("Unknown flag");
    expect(JSON.parse(result.stdout)).toMatchObject({
      code: "capability_unavailable",
    });
    const selected: unknown[] = [];
    const parsed = await serveRegisteredCliFixture(
      (fixture) => {
        registerUtilityCommands(
          fixture,
          silentLogger,
          {},
          {
            runSessionStatus: async () => {
              throw new Error("No status acquisition permitted");
            },
            runProviderAnalysis: async (path, operation, parameters) => {
              selected.push({ path, operation, parameters });
              throw new AnalysisInputError(operation, undefined, [
                {
                  path: ["path"],
                  reason: "invalid_value",
                  message: `Declared synthetic target ${path} is absent`,
                },
              ]);
            },
          },
        );
      },
      [
        "inspect-plist",
        "/nonexistent/REA.app",
        "--relative-path",
        "Contents/Info.plist",
        "--json",
      ],
    );
    expect(parsed.stdout).not.toContain("Unknown flag");
    expect(parsed.stdout).toContain("/nonexistent/REA.app");
    expect(selected).toEqual([
      {
        path: "/nonexistent/REA.app",
        operation: "inspect_plist",
        parameters: { path: "Contents/Info.plist" },
      },
    ]);
  });
});
