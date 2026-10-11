import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { createStrippedAsarAddon } from "../../fixtures/strippedAsarAddon.js";
import { analyzeJavaScriptApplication } from "../../support/javascriptApplicationScope.js";

const execute = promisify(execFile);
const run = async (arguments_: readonly string[]): Promise<unknown> => {
  const { stdout } = await execute(
    process.execPath,
    ["scripts/rea.mjs", ...arguments_, "--json"],
    { cwd: process.cwd(), maxBuffer: 16 * 1024 * 1024 },
  );
  return JSON.parse(stdout);
};

it.each(["analyze-javascript-application", "analyze"])(
  "%s denies public archives while the owned producer preserves integrity policy",
  async (command) => {
    const { archive, addon } = await createStrippedAsarAddon();
    await expect(
      run([command, archive, "--integrity-policy", "record-and-continue"]),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining("capability_unavailable"),
    });
    const result = await analyzeJavaScriptApplication({
      input_path: archive,
      integrity_policy: "record-and-continue",
    });
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      operation: "analyze_javascript_application",
      parameters: { integrity_policy: "record-and-continue" },
      normalized_result: {
        integrity_contradictions: [
          { logical_path: addon, trust: "observed-untrusted" },
        ],
        graph: { coverage: { status: "partial" } },
      },
    });
  },
);

it("rejects the JavaScript integrity policy on binary-only inspection", async () => {
  await expect(
    run(["inspect", "unused.asar", "--integrityPolicy", "record-and-continue"]),
  ).rejects.toMatchObject({
    code: 1,
    stdout: expect.stringContaining("Unknown flag: --integrityPolicy"),
  });
});
