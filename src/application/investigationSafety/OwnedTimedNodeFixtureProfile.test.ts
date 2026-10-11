import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { processScenarioSchema } from "../../domain/process/processScenario.js";
import { verifyOwnedNodeFixtureScript } from "./OwnedNodeFixtureProfile.js";
import { verifyOwnedTimedNodeFixtureScript } from "./OwnedTimedNodeFixtureProfile.js";
import {
  admitOwnedFixtureOperation,
  attachOwnedFixturePolicy,
  digestOwnedFixtureInput,
  registerOwnedFixtureHandlerEnvironment,
  sealOwnedFixturePolicy,
  type OwnedFixturePolicyData,
} from "./OwnedFixturePolicy.js";
import {
  OWNED_TIMED_FIXTURE_CAPABILITY,
  OWNED_TIMED_FIXTURE_HEAP_ARGUMENT,
} from "./OwnedFixturePolicyData.js";

const accepted = [
  "process.stdout.write('STARTED\\n');setTimeout(() => process.stdout.write('DONE\\n'),1600);",
  "const timer=setInterval(() => process.stdout.write('BUSY\\n'),12);setTimeout(() => clearInterval(timer),650);",
  "setInterval(() => undefined,1000);",
  "const label='OWNED';setTimeout(() => {process.stdout.write(label);process.stderr.write('DONE');},100);",
];

describe("explicit timed-output fixture grammar", () => {
  it.each(accepted)(
    "admits only reviewed timed expression structure: %s",
    (source) => {
      expect(() => verifyOwnedTimedNodeFixtureScript(source)).not.toThrow();
      expect(() => verifyOwnedNodeFixtureScript(source)).toThrow();
    },
  );
  it.each([
    "import fs from 'node:fs';setTimeout(() => undefined,1);",
    "setTimeout(() => require('node:fs'),1);",
    "setTimeout(() => import('node:fs'),1);",
    "setTimeout(() => eval('untrusted'),1);",
    "setTimeout(() => Function('untrusted')(),1);",
    "setTimeout(() => process.env,1);",
    "setTimeout(() => Object.hasOwn(process.env,'TOKEN'),1);",
    "setTimeout(() => process.kill(1),1);",
    "setTimeout(() => process.stdin.resume(),1);",
    "setTimeout(() => process.argv,1);",
    "setTimeout(() => globalThis,1);",
    "setTimeout(() => process.stdout.write=undefined,1);",
    "setTimeout(() => {const value=1;process.stdout.write(String(value));},1);",
    "let value=0;setTimeout(() => value++,1);",
    "const alias=setTimeout;alias(() => undefined,1);",
    "const setTimeout=String;setTimeout(() => undefined,1);",
    "const process=JSON;setTimeout(() => process.stdout.write('hidden'),1);",
    "setTimeout(function () {},1);",
    "setTimeout(async () => undefined,1);",
    "setTimeout((value) => value,1);",
    "const callback=() => undefined;setTimeout(callback,1);",
    "setTimeout(() => {return undefined;},1);",
    "setTimeout(() => {'use strict';process.stdout.write('hidden');},1);",
    "setTimeout(() => setTimeout(() => undefined,1),1);",
    "JSON.stringify(setTimeout(() => undefined,1));",
    "setTimeout('source text',1);",
    "setTimeout(() => undefined,0);",
    "setTimeout(() => undefined,-1);",
    "setTimeout(() => undefined,10001);",
    "setTimeout(() => undefined,Infinity);",
    "setTimeout(() => undefined,1+1);",
    "setTimeout(() => undefined,1,process);",
    "setTimeout(() => clearTimeout(missing),1);",
    "const timer=setInterval(() => undefined,1);clearTimeout(timer);",
    "const timer=setInterval(() => undefined,1);String(timer);",
    "const timer=setInterval(() => undefined,1);const alias=timer;",
    "const timer=setInterval(() => undefined,1);setTimeout(() => timer.refresh(),1);",
    "const timer=setInterval(() => undefined,1);clearInterval(...[timer]);",
    "export const process=JSON;setTimeout(() => undefined,1);",
    "export const label='OWNED';setTimeout(() => process.stdout.write(label),1);",
    "export {};setTimeout(() => undefined,1);",
    "export default setTimeout(() => undefined,1);",
    "const aggregate=['literal'];setTimeout(() => undefined,1);",
    "const aggregate={value:'literal'};setTimeout(() => undefined,1);",
    "const label='x'+'x';setTimeout(() => process.stdout.write(label),1);",
    "const label=`x`;setTimeout(() => process.stdout.write(label),1);",
    "const value=1e999;setTimeout(() => undefined,1);",
    "const label=String('x');setTimeout(() => process.stdout.write(label),1);",
    "const label='x';const alias=label;setTimeout(() => process.stdout.write(alias),1);",
    "setTimeout(() => process.stdout.write(JSON.stringify('literal')),1);",
    "setTimeout(() => process.stdout.write(String(123)),1);",
    "setTimeout(() => process.stdout.write(123),1);",
    "setTimeout(() => process.stdout.write('x','utf8'),1);",
  ])("rejects escapes before any process can execute: %s", (source) => {
    expect(() => verifyOwnedTimedNodeFixtureScript(source)).toThrow();
  });
  it("bounds schedule count, interval count and callback statements", () => {
    for (const source of [
      "setTimeout(() => undefined,1);".repeat(65),
      "setInterval(() => undefined,1);".repeat(5),
      `setTimeout(() => {${"process.stdout.write('x');".repeat(17)}},1);`,
    ])
      expect(() => verifyOwnedTimedNodeFixtureScript(source)).toThrow();
  });
  it.each(["clearInterval", "clearTimeout", "setInterval", "setTimeout"])(
    "rejects exported timer binding shadowing: %s",
    (identifier) => {
      expect(() =>
        verifyOwnedTimedNodeFixtureScript(
          `export const ${identifier}=Number;const timer=setInterval(() => process.stdout.write('BUSY'),1);setTimeout(() => clearInterval(timer),10);`,
        ),
      ).toThrow();
    },
  );
  it("rejects aggregate and string expansion before evaluation", () => {
    const arrays = ["const value0=['x'];"];
    const strings = ["const value0='x';"];
    for (let index = 1; index <= 30; index++) {
      arrays.push(`const value${index}=[value${index - 1},value${index - 1}];`);
      strings.push(`const value${index}=value${index - 1}+value${index - 1};`);
    }
    arrays.push(
      "setTimeout(() => process.stdout.write(JSON.stringify(value30)),1);",
    );
    strings.push("setTimeout(() => process.stdout.write(value30),1);");
    for (const source of [arrays.join(""), strings.join("")])
      expect(() => verifyOwnedTimedNodeFixtureScript(source)).toThrow();
  });
  it("bounds literal strings, total literal data and source bytes", () => {
    for (const source of [
      `setTimeout(() => process.stdout.write('${"x".repeat(4097)}'),1);`,
      `setTimeout(() => process.stdout.write('${"😀".repeat(1025)}'),1);`,
      Array.from(
        { length: 17 },
        (_, index) => `const label${index}='${"x".repeat(4096)}';`,
      ).join(""),
      `/*${"x".repeat(1024 * 1024)}*/setTimeout(() => undefined,1);`,
    ])
      expect(() => verifyOwnedTimedNodeFixtureScript(source)).toThrow();
    expect(() =>
      verifyOwnedTimedNodeFixtureScript(
        `const label='${"x".repeat(4096)}';setTimeout(() => process.stdout.write(label),1);`,
      ),
    ).not.toThrow();
  });
});

const processFixture = async (source = accepted[0]!) => {
  const root = await createTestTempDirectory("rea-owned-timed-profile-");
  const executable = await realpath(process.execPath);
  const script = join(root, "timed.mjs");
  await writeFile(script, source);
  const input = processScenarioSchema.parse({
    executable,
    arguments: [OWNED_TIMED_FIXTURE_HEAP_ARGUMENT, script],
    working_directory: root,
    timeout_ms: 10000,
    idle_timeout_ms: 10000,
  });
  const data: OwnedFixturePolicyData = {
    roots: [root],
    files: [
      {
        path: executable,
        sha256: createHash("sha256")
          .update(await readFile(executable))
          .digest("hex"),
        role: "executable",
      },
      {
        path: script,
        sha256: createHash("sha256").update(source).digest("hex"),
        role: "dependency",
      },
    ],
    environment: [],
    endpoints: [],
    available_capabilities: [OWNED_TIMED_FIXTURE_CAPABILITY],
    grants: [
      {
        operation: "capture_process_scenario",
        input_digest: digestOwnedFixtureInput(input),
        capability: OWNED_TIMED_FIXTURE_CAPABILITY,
        mode: "owned-files",
      },
    ],
  };
  return { root, script, input, data };
};
const admit = async (data: OwnedFixturePolicyData, input: unknown) => {
  const token = await sealOwnedFixturePolicy(data);
  const owner = {};
  registerOwnedFixtureHandlerEnvironment(owner, {});
  attachOwnedFixturePolicy(owner, token);
  return admitOwnedFixtureOperation(owner, "capture_process_scenario", input);
};

describe("sealed timed-output profile selection", () => {
  it("retains the baseline no-flag route for baseline expression fixtures", async () => {
    const { data, input, script } = await processFixture(
      "process.stdout.write('BASELINE');",
    );
    const baselineInput = { ...input, arguments: [script] };
    const capability = "owned-synthetic-process-capture";
    await expect(
      admit(
        {
          ...data,
          available_capabilities: [capability],
          grants: data.grants.map((grant) => ({
            ...grant,
            capability,
            input_digest: digestOwnedFixtureInput(baselineInput),
          })),
        },
        baselineInput,
      ),
    ).resolves.toMatchObject({ mode: "owned-files", capability });
  });
  it("requires the exact explicit Node old-space flag before the sealed script", async () => {
    const { data, input, script } = await processFixture();
    const withArguments = (arguments_: string[]) => {
      const changed = { ...input, arguments: arguments_ };
      return admit(
        {
          ...data,
          grants: data.grants.map((grant) => ({
            ...grant,
            input_digest: digestOwnedFixtureInput(changed),
          })),
        },
        changed,
      );
    };
    for (const arguments_ of [
      [script],
      ["--max-old-space-size=128", script],
      ["--max_old_space_size=64", script],
      ["--max-old-space-size=64", "--eval", "process.exit()"],
      ["--max-old-space-size=64", script, "--max-old-space-size=128"],
      [script, "--max-old-space-size=64"],
    ])
      await expect(withArguments(arguments_)).rejects.toThrow();
    await expect(
      withArguments(["--max-old-space-size=64", script]),
    ).resolves.toMatchObject({ mode: "owned-files" });
  });
  it("requires an exact opt-in grant and preserves strict baseline rejection", async () => {
    const { data, input } = await processFixture();
    await expect(admit(data, input)).resolves.toMatchObject({
      mode: "owned-files",
      environment: {},
    });
    const baseline = "owned-synthetic-process-capture";
    await expect(
      admit(
        {
          ...data,
          available_capabilities: [baseline],
          grants: data.grants.map((grant) => ({
            ...grant,
            capability: baseline,
          })),
        },
        input,
      ),
    ).rejects.toThrow();
    await expect(
      admit(data, { ...input, timeout_ms: 9000 }),
    ).resolves.toBeUndefined();
  });
  it("rejects credential-bearing startup, endpoints and non-process grant selection at seal", async () => {
    const { data } = await processFixture();
    for (const changed of [
      { ...data, environment: [{ name: "LANG", value: "C" }] },
      { ...data, endpoints: ["http://127.0.0.1:8123"] },
      {
        ...data,
        grants: data.grants.map((grant) => ({
          ...grant,
          mode: "nonexecuting-stub" as const,
          operation: "list_documents",
          port_id: "fake",
        })),
      },
    ])
      await expect(sealOwnedFixturePolicy(changed)).rejects.toThrow();
  });
});

describe("sealed timed-output scenario and file bounds", () => {
  it("rejects scenario authority beyond timed output, with exact digests", async () => {
    const { data, input, root } = await processFixture();
    for (const addition of [
      { timeout_ms: 15001 },
      { idle_timeout_ms: 15001 },
      { settle_ms: 1001 },
      { finalization_ms: 1 },
      { filesystem_observation_paths: [root] },
      { environment: { REA_LOG_LEVEL: "silent" } },
    ]) {
      const changed = processScenarioSchema.parse({ ...input, ...addition });
      await expect(
        admit(
          {
            ...data,
            grants: data.grants.map((grant) => ({
              ...grant,
              input_digest: digestOwnedFixtureInput(changed),
            })),
          },
          changed,
        ),
      ).rejects.toThrow();
    }
  });
  it("rejects output, normalization and interaction budgets beyond the timed profile", async () => {
    const { data, input } = await processFixture();
    for (const addition of [
      { limits: { output_bytes: 1000001 } },
      {
        normalization: {
          patterns: [{ pattern: "a", replacement: "x".repeat(65537) }],
        },
      },
      {
        events: Array.from({ length: 65 }, (_, at_ms) => ({
          type: "signal",
          at_ms,
          signal: "SIGINT",
        })),
      },
      { events: [{ type: "input", at_ms: 0, data: "x".repeat(4097) }] },
      { events: [{ type: "input", at_ms: 0, data: "😀".repeat(1025) }] },
      {
        events: Array.from({ length: 17 }, (_, at_ms) => ({
          type: "input",
          at_ms,
          data: "x".repeat(4096),
        })),
      },
    ]) {
      const changed = processScenarioSchema.parse({ ...input, ...addition });
      await expect(
        admit(
          {
            ...data,
            grants: data.grants.map((grant) => ({
              ...grant,
              input_digest: digestOwnedFixtureInput(changed),
            })),
          },
          changed,
        ),
      ).rejects.toThrow();
    }
  });
  it("accepts exact finite interaction/output boundaries with default normalization", async () => {
    const { data, input } = await processFixture();
    const changed = processScenarioSchema.parse({
      ...input,
      limits: { output_bytes: 1000000 },
      events: Array.from({ length: 64 }, (_, at_ms) => ({
        type: "input",
        at_ms,
        data: "x".repeat(1024),
      })),
    });
    await expect(
      admit(
        {
          ...data,
          grants: data.grants.map((grant) => ({
            ...grant,
            input_digest: digestOwnedFixtureInput(changed),
          })),
        },
        changed,
      ),
    ).resolves.toMatchObject({ mode: "owned-files" });
  });
  it("refuses changed or unseeded scripts before runtime evidence is possible", async () => {
    const { data, input, script, root } = await processFixture();
    await writeFile(
      script,
      "setTimeout(() => process.stdout.write('CHANGED'),100);",
    );
    await expect(admit(data, input)).rejects.toThrow();
    const unseeded = {
      ...input,
      arguments: [
        OWNED_TIMED_FIXTURE_HEAP_ARGUMENT,
        join(root, "unseeded.mjs"),
      ],
    };
    await expect(
      admit(
        {
          ...data,
          files: data.files.filter((file) => file.path !== script),
          grants: data.grants.map((grant) => ({
            ...grant,
            input_digest: digestOwnedFixtureInput(unseeded),
          })),
        },
        unseeded,
      ),
    ).rejects.toThrow();
  });
});
