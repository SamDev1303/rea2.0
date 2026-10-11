import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { quantityInvestigationFixture } from "../../fixtures/investigationWorkflow/quantitySpecification.js";
import { serveCli } from "../cli/cliServeHarness.js";

describe("public investigation workflow boundaries", () => {
  it("CLI previews cannot treat caller reports as verified run receipts", async () => {
    const directory = await createTestTempDirectory("rea2-investigation-cli-");
    const path = join(directory, "investigation.json");
    const { input } = quantityInvestigationFixture();
    await writeFile(path, JSON.stringify(input));
    const response = await serveCli([
      "reconcile-investigation",
      path,
      "--json",
    ]);
    const output: unknown = JSON.parse(response.stdout);
    expect(output).toMatchObject({ status: "incomplete" });
    expect(response.stdout).toContain("trusted read-only run receipt");
  });

  it("CLI does not accept JSON flags as builder handoff authority", async () => {
    const savedExitCode = process.exitCode;
    try {
      const response = await serveCli(["prepare-builder-handoff", "--json"]);
      expect(response.stdout).toContain("capability_unavailable");
      expect(response.stdout).toContain(
        "Public documents cannot provide trusted",
      );
    } finally {
      process.exitCode = savedExitCode;
    }
  });

  it("MCP advertises strict previews, retains incompleteness and reports unavailable handoff", async () => {
    const { client, close } = await createApplicationMcpHarness();
    onTestFinished(close);
    const listing = await client.listTools();
    expect(
      listing.tools.some((tool) => tool.name === "reconcile_investigation"),
    ).toBe(true);
    const { input } = quantityInvestigationFixture();
    const response = await client.callTool({
      name: "reconcile_investigation",
      arguments: { investigation: input },
    });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({ status: "incomplete" });
    const handoff = await client.callTool({
      name: "prepare_builder_handoff",
      arguments: {},
    });
    expect(handoff.structuredContent).toMatchObject({ status: "unavailable" });
    const forged = await client.callTool({
      name: "prepare_builder_handoff",
      arguments: { trusted: true, can_write: false },
    });
    expect(forged.isError).toBe(true);
  });
});
