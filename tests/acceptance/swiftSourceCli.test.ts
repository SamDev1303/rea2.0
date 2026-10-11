import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { parseEvidence } from "../../src/domain/evidence.js";
import { swiftSourceAnalysisSchema } from "../../src/domain/swift/swiftSourceAnalysis.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "maps owned inert Swift through the compiled public CLI",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-swift-cli-");
    await writeFile(
      join(root, "Model.swift"),
      "struct Model { func save() { writeData() } }",
    );
    const response = await cli.run({
      arguments: ["analyze-swift-application", root, "--json"],
    });
    expect(response.exitCode, response.stderr).toBe(0);
    const result = swiftSourceAnalysisSchema.parse(
      parseEvidence(response.json).normalized_result,
    );
    expect(result.coverage.source_files).toBe(1);
    expect(result.files[0]!.call_candidates).toMatchObject([
      { name: "writeData", resolution: "unresolved" },
    ]);
  },
);

cliTest(
  "returns a nonzero typed failure for missing Swift coverage",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-swift-cli-empty-");
    const response = await cli.run({
      arguments: ["analyze-swift-application", root, "--json"],
    });
    expect(response.exitCode).toBe(1);
    expect(response.json).toMatchObject({ code: "unsupported_target" });
  },
);

cliTest(
  "keeps cleanup failure and the original error when cancellation also arrives",
  async ({ processes }) => {
    const response = await processes.run(
      process.execPath,
      [
        fileURLToPath(
          new URL("../fixtures/swiftSourceCliCleanup.mjs", import.meta.url),
        ),
      ],
      { env: {}, timeoutMs: 10_000 },
    );
    expect(response.exitCode, response.stderr).toBe(1);
    expect(JSON.parse(response.stdout)).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        cleanup: "incomplete",
        resources: ["Swift source directory reader"],
        diagnostics: {
          primary_error: {
            details: {
              diagnostics: { primary_error: { code: "unsupported_target" } },
            },
          },
          cleanup_error: { code: "cleanup_incomplete" },
        },
      },
    });
  },
);
