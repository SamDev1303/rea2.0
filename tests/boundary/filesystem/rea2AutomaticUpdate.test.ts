import { EventEmitter } from "node:events";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createCli } from "../../../src/cli.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const childProcess = createRequire(import.meta.url)(
  "node:child_process",
) as typeof import("node:child_process");
const launcher = resolve(import.meta.dirname, "../../../scripts/rea.mjs");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  syncBuiltinESMExports();
});

const observeUpdate = async (argv: string[], terminal = false) => {
  // Patch the real builtin bindings before entering the external SDK. No
  // updater, child process or package manager can run in this regression.
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    calls.push("fetch");
    throw new Error("Owned update regression blocks registry requests");
  });
  for (const name of [
    "exec",
    "execSync",
    "execFileSync",
    "spawnSync",
    "fork",
  ] as const) {
    vi.spyOn(childProcess, name).mockImplementation(() => {
      calls.push(name);
      throw new Error("Owned update regression blocks process execution");
    });
  }
  vi.spyOn(childProcess, "execFile").mockImplementation(
    (...args: unknown[]) => {
      calls.push("execFile");
      const callback = args.at(-1) as (
        error: Error,
        stdout: string,
        stderr: string,
      ) => void;
      callback(
        new Error("Owned update regression blocks installation"),
        "",
        "",
      );
      return new EventEmitter() as ReturnType<typeof childProcess.execFile>;
    },
  );
  vi.spyOn(childProcess, "spawn").mockImplementation(() => {
    calls.push("spawn");
    return Object.assign(new EventEmitter(), {
      unref() {},
    }) as ReturnType<typeof childProcess.spawn>;
  });
  syncBuiltinESMExports();
  vi.stubEnv("XDG_CACHE_HOME", await createTestTempDirectory("rea2-update-"));
  vi.stubEnv("CI", "false");
  vi.stubEnv("NO_UPDATE_NOTIFIER", "");
  vi.stubEnv("npm_config_update_notifier", "true");
  const oldArgv = process.argv;
  const oldTerminal = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
  process.argv = [process.execPath, launcher, ...argv];
  Object.defineProperty(process.stdout, "isTTY", {
    configurable: true,
    value: terminal,
  });
  let output = "";
  const exits: number[] = [];
  try {
    const cli = createCli({});
    cli.command("owned-update-observation", { run: () => ({ owned: true }) });
    await cli.serve(argv, {
      stdout: (value) => {
        output += value;
      },
      exit: (code) => exits.push(code),
    });
  } finally {
    process.argv = oldArgv;
    if (oldTerminal)
      Object.defineProperty(process.stdout, "isTTY", oldTerminal);
    else Reflect.deleteProperty(process.stdout, "isTTY");
  }
  return { calls, output, exits };
};

describe("local fork never delegates updates to the SDK", () => {
  it.each([["--update"], ["owned-update-observation", "--", "--update"]])(
    "rejects SDK update interception for %j without spawning",
    async (...argv) => {
      const result = await observeUpdate(argv);
      expect(result.calls).toEqual([]);
      expect(result.exits).toEqual([1]);
      expect(result.output).toContain("reviewed local build");
    },
  );

  it("does not launch detached update checks for human command output", async () => {
    const result = await observeUpdate(["owned-update-observation"], true);
    expect(result.calls).toEqual([]);
    expect(result.exits).toEqual([]);
    expect(result.output).toContain("owned");
  });

  it("does not run the hidden SDK update refresh", async () => {
    const result = await observeUpdate(["--incur-update-check"]);
    expect(result.calls).toEqual([]);
    expect(result.exits).toEqual([]);
  });
});
