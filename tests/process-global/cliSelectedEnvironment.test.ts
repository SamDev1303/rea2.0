import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createCli } from "../../src/cli.js";
import { createDirectAnalysis } from "../../src/composition/directAnalysis.js";
import { parseEvidence } from "../../src/domain/evidence.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

const initialExitCode = process.exitCode;
afterEach(() => {
  vi.unstubAllEnvs();
  process.exitCode = initialExitCode;
});

const serve = async (
  cli: ReturnType<typeof createCli>,
  arguments_: string[],
) => {
  let stdout = "";
  await cli.serve([...arguments_, "--json"], {
    env: {},
    stdout: (text) => {
      stdout += text;
    },
    exit: () => undefined,
  });
  const result: unknown = JSON.parse(stdout);
  return result;
};

describe("CLI selected environment", () => {
  it("retains the selected binary provider and launcher after caller and ambient environment changes", async () => {
    vi.stubEnv("REA_ANALYSIS_PROVIDER", "ambient-provider");
    vi.stubEnv("HOPPER_LAUNCHER_PATH", "/ambient/hopper");
    const environment = {
      REA_ANALYSIS_PROVIDER: "selected-provider",
      HOPPER_LAUNCHER_PATH: process.execPath,
    };
    const cli = createCli(environment);
    const direct = createDirectAnalysis(environment);
    environment.REA_ANALYSIS_PROVIDER = "changed-provider";
    environment.HOPPER_LAUNCHER_PATH = "/changed/hopper";
    const root = await createTestTempDirectory("rea-cli-selected-env-");
    const target = join(root, "fixture.hop");
    await writeFile(target, "fixture");

    for (const command of [
      ["decompile", target, "main"],
      ["read-bytes", target, "0x1000"],
    ]) {
      const denied = await serve(cli, command);
      expect(denied).toMatchObject({ code: "capability_unavailable" });
      // Authored inert .hop bytes reach the maintained factory; unknown selected
      // provider rejects before any engine startup. Public host execution stays denied.
      const result =
        command[0] === "decompile"
          ? await direct.runDirectAnalysis(target, "procedure_pseudo_code", {
              procedure: "main",
            })
          : await direct.runDirectAnalysis(target, "read_bytes", {
              address: "0x1000",
            });
      expect(result).toMatchObject({
        code: "capability_unavailable",
        details: { requested_provider_id: "selected-provider" },
      });
    }
    for (const command of ["providers", "capabilities"]) {
      const result = await serve(cli, [command]);
      expect(result).toMatchObject({
        analysis_provider_candidates: expect.arrayContaining([
          expect.objectContaining({
            provider: expect.objectContaining({ id: "hopper" }),
            availability: expect.objectContaining({
              diagnostics: expect.objectContaining({
                launcher_path: process.execPath,
              }),
            }),
          }),
        ]),
      });
    }
  });

  it("does not borrow invalid ambient settings or capture inherited environment in artifact Evidence", async () => {
    vi.stubEnv("REA_GHIDRA_STARTUP_TIMEOUT_MS", "ambient-invalid-setting");
    vi.stubEnv(
      "REA_AMBIENT_CAPTURE_SENTINEL",
      "ambient-value-must-not-be-captured",
    );
    const root = await createTestTempDirectory("rea-cli-isolated-artifact-");
    const target = join(root, "empty.zip");
    await writeFile(
      target,
      Buffer.from("504b0506000000000000000000000000000000000000", "hex"),
    );
    const selected = {
      REA_SELECTED_CAPTURE_SENTINEL: "selected-value-must-not-be-captured",
    };
    const cli = createCli(selected);
    const direct = createDirectAnalysis(selected);
    expect(await serve(cli, ["inspect-artifact", target])).toMatchObject({
      code: "capability_unavailable",
    });
    const result = await direct.runProviderAnalysis(
      target,
      "inspect_artifact",
      {},
    );
    const evidence = parseEvidence(result);
    expect(evidence.operation).toBe("inspect_artifact");
    expect(evidence.subject?.local_path).toBe(target);
    expect(evidence.environment).toBeNull();
    const serialized = JSON.stringify(evidence);
    expect(serialized).not.toContain("CAPTURE_SENTINEL");
    expect(serialized).not.toContain("value-must-not-be-captured");
  });
});
