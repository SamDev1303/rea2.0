import { snapshotPublicInvestigationInput } from "../application/investigationSafety/PublicInputSnapshot.js";
import { AnalysisError } from "../domain/analysisErrorBase.js";
import { Cli } from "incur";
import { admitInvestigationInput } from "../application/investigationSafety/InvestigationAdmission.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { CliInstance } from "./types.js";
import {
  admitOwnedFixtureOperation,
  retryOwnedFixtureCleanup,
} from "../application/investigationSafety/OwnedFixturePolicy.js";
import { runOwnedFixtureExecution } from "../application/investigationSafety/OwnedFixtureExecution.js";
import { admitPublicJavaScriptInput } from "../application/investigationSafety/PublicJavaScriptInput.js";
import { admitPublicJavaScriptAlias } from "./publicJavaScriptRoute.js";

type CommandMap = NonNullable<ReturnType<typeof Cli.toCommands.get>>;
const registeredCommands: WeakMap<object, CommandMap> = Cli.toCommands;

/** Wrap registered leaf handlers, including groups, before any target acquisition. */
export const protectInvestigationCommands = (cli: CliInstance): void => {
  const commands = registeredCommands.get(cli);
  if (commands !== undefined) wrap(cli, commands);
  const serve = cli.serve.bind(cli);
  cli.serve = async (argv = process.argv.slice(2), options) => {
    // Incur intercepts this flag even after `--` and ignores update:false for
    // explicit installs. Reject it before entering the SDK's builtin parser.
    if (argv.includes("--update")) {
      (options?.stdout ?? ((value: string) => process.stdout.write(value)))(
        JSON.stringify({
          code: "capability_unavailable",
          message:
            "SDK updates are disabled. Use rea2 update for the reviewed local build workflow.",
        }) + "\n",
      );
      if (options?.exit !== undefined) options.exit(1);
      else process.exitCode = 1;
      return;
    }
    if (
      argv.some((value, index) => value === "mcp" && argv[index + 1] === "add")
    ) {
      (options?.stdout ?? ((value: string) => process.stdout.write(value)))(
        JSON.stringify({
          code: "capability_unavailable",
          message:
            "Automatic MCP installers are disabled. Use rea2 setup --dry-run and the reviewed local configuration writer.",
        }) + "\n",
      );
      if (options?.exit !== undefined) options.exit(1);
      else process.exitCode = 1;
      return;
    }
    try {
      await serve(argv, options);
    } catch (primary: unknown) {
      try {
        await retryOwnedFixtureCleanup(cli);
      } catch (cleanup: unknown) {
        throw new AggregateError(
          [primary, cleanup],
          "CLI operation and owned fixture cleanup both failed",
          { cause: primary },
        );
      }
      throw primary;
    }
    await retryOwnedFixtureCleanup(cli);
  };
};
type CommandEntry = CommandMap extends Map<string, infer Entry> ? Entry : never;
type Leaf = Exclude<
  CommandEntry,
  { _group: true } | { _alias: true } | { _fetch: true }
>;

const wrapLeaf = (owner: CliInstance, name: string, entry: Leaf): void => {
  const run = entry.run;
  entry.run = async (context) => {
    try {
      const input = snapshotPublicInvestigationInput(name, {
        args: context.args,
        options: context.options,
      });
      const executionContext = Object.freeze({ ...context, ...input });
      const admitted = await admitOwnedFixtureOperation(owner, name, input);
      if (admitted === undefined) {
        const directoryAlias =
          name === "analyze" &&
          (await admitPublicJavaScriptAlias(executionContext));
        if (!directoryAlias) {
          await admitInvestigationInput(name, input);
          await admitPublicJavaScriptInput(name, input);
        }
      }
      return await runOwnedFixtureExecution(admitted, () =>
        run(executionContext),
      );
    } catch (cause: unknown) {
      if (!(cause instanceof AnalysisError)) throw cause;
      const error = projectAnalysisError(cause);
      return context.error({
        code: error.code,
        message: error.message,
        exitCode: 1,
      });
    }
  };
};

const wrap = (owner: CliInstance, commands: CommandMap): void => {
  for (const [name, entry] of commands) {
    if ("_group" in entry) {
      if (entry.root !== undefined) wrapLeaf(owner, name, entry.root);
      wrap(owner, entry.commands);
    } else if ("_fetch" in entry) {
      // Fetch gateways are not audited investigation surfaces.
      entry.fetch = () =>
        new Response(
          JSON.stringify({
            code: "capability_unavailable",
            message:
              "Unaudited fetch gateways are unavailable on protected hosts.",
          }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
    } else if (!("_alias" in entry)) wrapLeaf(owner, name, entry);
  }
};
