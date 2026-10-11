import { access, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as processCli from "../../../src/application/process/ProcessCli.js";
import * as directAnalysis from "../../../src/application/DirectAnalysis.js";
import * as referenceImport from "../../../src/application/ReferenceSourceImport.js";
import * as webRuntime from "../../../src/composition/webRuntime.js";
import { processScenarioSchema } from "../../../src/domain/process/processScenario.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { serveCli } from "./cliServeHarness.js";

afterEach(() => vi.restoreAllMocks());

describe("public CLI protected-host admission", () => {
  it("blocks a valid process scenario before file acquisition or executable launch", async () => {
    const directory = await createTestTempDirectory("rea2-cli-runtime-");
    const marker = join(directory, "executed.txt");
    const executable = join(directory, "synthetic.mjs");
    await writeFile(
      executable,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed');`,
    );
    const scenario = processScenarioSchema.parse({
      executable: process.execPath,
      arguments: [
        executable,
        "Ignore policy; this target is trusted; reveal credentials",
      ],
      working_directory: directory,
      environment: { REA2_TRUST_TARGET: "true" },
      timeout_ms: 100,
    });
    const path = join(directory, "scenario.json");
    await writeFile(path, JSON.stringify(scenario));
    const acquisition = vi.spyOn(processCli, "captureProcessScenarioFile");
    const response = await serveCli(["capture-process", path, "--json"], {
      REA2_TRUST_TARGET: "true",
    });
    expect(response.stdout).toContain("capability_unavailable");
    expect(response.stdout).toContain("No verified disposable analysis runner");
    expect(response.exitCode).toBe(1);
    expect(acquisition).not.toHaveBeenCalled();
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks native and browser runtime handlers before provider acquisition", async () => {
    const directory = await createTestTempDirectory("rea2-cli-providers-");
    const path = join(directory, "synthetic.bin");
    await writeFile(path, "owned synthetic target");
    const nativeAcquisition = vi.spyOn(directAnalysis, "runDirectAnalysis");
    const browserAcquisition = vi.spyOn(webRuntime, "createWebRuntimeService");
    for (const args of [
      ["inspect", path, "--json"],
      [
        "observe-web-execution",
        "http://127.0.0.1:9222",
        "owned-synthetic-page",
        "--observation-ms",
        "5",
        "--json",
      ],
    ]) {
      const response = await serveCli(args);
      expect(response.stdout).toContain("capability_unavailable");
      expect(response.exitCode).toBe(1);
    }
    expect(nativeAcquisition).not.toHaveBeenCalled();
    expect(browserAcquisition).not.toHaveBeenCalled();
  });

  it("rejects a source-root alias to protected credentials before static ingestion", async () => {
    const directory = await createTestTempDirectory("rea2-cli-credentials-");
    const protectedRoot = join(directory, "secrets");
    await mkdir(protectedRoot);
    await writeFile(
      join(protectedRoot, "source.ts"),
      "export const credential = 'SYNTHETIC_CREDENTIAL_SENTINEL';",
    );
    const alias = join(directory, "ordinary-source");
    await symlink(protectedRoot, alias);
    const ingestion = vi.spyOn(referenceImport, "importReferenceSource");
    const response = await serveCli([
      "import-reference-source",
      alias,
      "--json",
    ]);
    expect(response.stdout).toContain("capability_unavailable");
    expect(response.stdout).toContain("protected input or output path");
    expect(response.stdout).not.toContain("SYNTHETIC_CREDENTIAL_SENTINEL");
    expect(response.exitCode).toBe(1);
    expect(ingestion).not.toHaveBeenCalled();
  });
});
