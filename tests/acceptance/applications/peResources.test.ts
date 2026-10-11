import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import pino from "pino";
import { registerBinaryDiagnosticsCommands } from "../../../src/cli/binaryDiagnosticsCommands.js";
import { createPeResourcesService } from "../../../src/composition/binaryDiagnostics.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { serveRegisteredCliFixture } from "../../support/cli/registeredCliFixture.js";
import { connectOwnedEvidenceFixture } from "../../support/cli/ownedEvidenceFixture.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { peResourcesSchema } from "../../../src/domain/native/peResources.js";
import { peResourceFixture } from "../../../src/native/pe/PeResources.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const runOwnedPeCli = async (cli: TestCli, path: string) => {
  const denied = await cli.run({
    arguments: ["inspect-pe-resources", path, "--json"],
  });
  expect(denied.exitCode).toBe(1);
  expect(denied.json).toMatchObject({ code: "capability_unavailable" });
  return serveRegisteredCliFixture(
    (registered) =>
      registerBinaryDiagnosticsCommands(
        registered,
        pino({ level: "silent" }),
        {},
      ),
    ["inspect-pe-resources", path, "--json"],
  );
};

const expectPublicPeDenial = async (client: Client, path: string) => {
  const response = await client.callTool({
    name: "inspect_pe_resources",
    arguments: { path },
  });
  expect(response.isError).toBe(true);
  expect(parseMcpToolError(response)).toMatchObject({
    error: { code: "capability_unavailable" },
  });
};

const expectPeInputFailureAcrossAdapters = async (input: {
  readonly cli: TestCli;
  readonly client: Client;
  readonly toolName: string;
  readonly path: string;
  readonly reason: "invalid_format" | "invalid_value";
}) => {
  const { cli, client, toolName, path, reason } = input;
  const result = await runOwnedPeCli(cli, path);
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "invalid_request",
    category: "invalid_input",
    details: {
      operation: "inspect_pe_resources",
      issues: [{ path: ["path"], reason }],
    },
  });
  expect(toolName).toBe("inspect_pe_resources");
  await expectPublicPeDenial(client, path);
  const response = await createPeResourcesService().inspect({ path });
  expect(response.ok).toBe(false);
  if (response.ok) throw new Error("Invalid PE accepted by actual producer");
  expect(projectAnalysisError(response.error)).toEqual(result.json);
};

const expectPePaddingFailureAcrossAdapters = async (input: {
  readonly cli: TestCli;
  readonly client: Client;
  readonly toolName: string;
  readonly path: string;
}) => {
  const { cli, client, toolName, path } = input;
  const fixture = peResourceFixture();
  const virtualSize = fixture.bytes.readUInt32LE(fixture.sectionAt + 8);
  fixture.bytes.writeUInt32LE(
    0x2000 + virtualSize,
    fixture.dataOffsets[0] ?? 0,
  );
  fixture.bytes.writeUInt32LE(4, (fixture.dataOffsets[0] ?? 0) + 4);
  await writeFile(path, fixture.bytes);
  const cliResult = await runOwnedPeCli(cli, path);
  expect(cliResult.exitCode).not.toBe(0);
  expect(toolName).toBe("inspect_pe_resources");
  await expectPublicPeDenial(client, path);
  const produced = await createPeResourcesService().inspect({ path });
  expect(produced.ok).toBe(false);
  if (produced.ok) throw new Error("Raw padding PE was accepted");
  const projected = projectAnalysisError(produced.error);
  expect(projected).toEqual(cliResult.json);
  expect(peResourcesSchema.safeParse(projected).success).toBe(false);
};

const expectPeInputFailuresAcrossAdapters = async (input: {
  readonly cli: TestCli;
  readonly client: Client;
  readonly toolName: string;
  readonly root: string;
}) => {
  const { cli, client, toolName, root } = input;
  const malformedPath = join(root, "malformed.exe");
  await writeFile(malformedPath, Buffer.from("not a PE image"));
  for (const [path, reason] of [
    [join(root, "missing.exe"), "invalid_value"],
    [malformedPath, "invalid_format"],
  ] as const)
    await expectPeInputFailureAcrossAdapters({
      cli,
      client,
      toolName,
      path,
      reason,
    });
};

const expectPeResourceEvidence = async (
  root: string,
  cli: TestCli,
  client: Client,
  owned: Awaited<ReturnType<typeof connectOwnedEvidenceFixture>>,
) => {
  const contract = toolContract("inspect_pe_resources");
  for (const plus of [false, true]) {
    const fixture = peResourceFixture(plus);
    const path = join(root, plus ? "resource64.exe" : "resource32.exe");
    await writeFile(path, fixture.bytes);
    const result = await runOwnedPeCli(cli, path);
    expect(result.exitCode).toBe(0);
    const evidence = contract.outputSchema.parse(result.json);
    const report = peResourcesSchema.parse(evidence.normalized_result);
    expect(evidence.subject?.digest).toMatchObject({
      sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
    });
    expect(report.coverage).toMatchObject({
      status: "complete",
      resources: 5,
    });
    expect(report.resources[0]?.payload.sha256).toBe(
      createHash("sha256").update("ICON").digest("hex"),
    );
    expect(
      report.resources.find(({ name }) => name.kind === "name")?.name,
    ).toMatchObject({ kind: "name", name: "7", utf16le_hex: "3700" });
    expect(report.icon_groups[0]?.images).toMatchObject([
      {
        resource_id: 1,
        candidate_resource_indices: [0, 1],
        same_language_resource_index: 0,
      },
      {
        resource_id: 99,
        candidate_resource_indices: [],
        same_language_resource_index: null,
      },
    ]);
    await expectPublicPeDenial(client, path);
    const produced = await createPeResourcesService().inspect({ path });
    expect(produced.ok).toBe(true);
    if (!produced.ok) throw produced.error;
    expect(owned.session.recordEvidence(produced.value)).toMatchObject({
      ok: true,
    });
    const response = await owned.client.callTool({
      name: "get_evidence_bundle",
      arguments: {},
    });
    expect(response.isError).not.toBe(true);
    const retained = response.structuredContent as {
      result: { records: unknown[] };
    };
    const mcp = contract.outputSchema.parse(
      retained.result.records.find(
        (record) =>
          contract.outputSchema.safeParse(record).success &&
          contract.outputSchema.parse(record).evidence_id ===
            evidence.evidence_id,
      ),
    );
    expect(mcp.evidence_id).toBe(evidence.evidence_id);
    expect(mcp.normalized_result).toEqual(evidence.normalized_result);
    const text = response.content.find(({ type }) => type === "text");
    if (text?.type !== "text") throw new Error("Missing MCP text Evidence");
    const textBundle = JSON.parse(text.text) as {
      result: { records: unknown[] };
    };
    expect(textBundle.result.records).toContainEqual(evidence);
    expect(await readFile(path)).toEqual(fixture.bytes);
  }
};

cliTest(
  "preserves PE32/PE32+ producer and formatter Evidence with real MCP retention while public parsing is denied",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-pe-resource-acceptance-");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve("scripts/rea.mjs"), "mcp"],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
      stderr: "pipe",
    });
    const client = new Client({ name: "pe-resource-acceptance", version: "1" });
    const contract = toolContract("inspect_pe_resources");
    try {
      await client.connect(transport);
      const inventory = await client.listTools();
      expect(inventory.tools).toContainEqual(
        expect.objectContaining({
          name: contract.name,
          annotations: expect.objectContaining({
            readOnlyHint: false,
            openWorldHint: false,
          }),
        }),
      );
      const session = await client.callTool({
        name: "binary_session",
        arguments: {},
      });
      expect(JSON.stringify(session.structuredContent)).toContain(
        "inspect_pe_resources",
      );
      const owned = await connectOwnedEvidenceFixture();
      await expectPeResourceEvidence(root, cli, client, owned);
      await expectPePaddingFailureAcrossAdapters({
        cli,
        client,
        toolName: contract.name,
        path: join(root, "raw-padding.exe"),
      });
      await expectPeInputFailuresAcrossAdapters({
        cli,
        client,
        toolName: contract.name,
        root,
      });
      const absent = peResourceFixture();
      absent.bytes.fill(0, absent.directoryAt, absent.directoryAt + 8);
      const path = join(root, "absent.exe");
      await writeFile(path, absent.bytes);
      await expectPublicPeDenial(client, path);
      const empty = await createPeResourcesService().inspect({ path });
      expect(empty.ok).toBe(true);
      if (!empty.ok) throw empty.error;
      expect(
        contract.outputSchema.parse(empty.value).normalized_result,
      ).toMatchObject({
        directory: null,
        resources: [],
        coverage: { status: "complete", resources: 0 },
      });
      for (const arguments_ of [
        { path, max_file_bytes: 64 },
        { path: "relative.exe" },
        { path, extra: true },
      ]) {
        const rejected = await client.callTool({
          name: contract.name,
          arguments: arguments_,
        });
        expect(rejected.isError).toBe(true);
        expect(
          contract.outputSchema.safeParse(rejected.structuredContent).success,
        ).toBe(false);
        const produced = await createPeResourcesService().inspect(arguments_);
        expect(produced.ok).toBe(false);
        if (produced.ok) throw new Error("Invalid PE input was accepted");
        expect(
          contract.outputSchema.safeParse(projectAnalysisError(produced.error))
            .success,
        ).toBe(false);
      }
      const damaged = peResourceFixture();
      damaged.bytes.writeUInt32LE(17, damaged.directoryAt + 4);
      const badPath = join(root, "damaged.exe");
      await writeFile(badPath, damaged.bytes);
      const rejected = await client.callTool({
        name: contract.name,
        arguments: { path: badPath },
      });
      expect(rejected.isError).toBe(true);
      expect(
        contract.outputSchema.safeParse(rejected.structuredContent).success,
      ).toBe(false);
      const malformed = await createPeResourcesService().inspect({
        path: badPath,
      });
      expect(malformed.ok).toBe(false);
      if (malformed.ok) throw new Error("Damaged PE directory was accepted");
      expect(
        contract.outputSchema.safeParse(projectAnalysisError(malformed.error))
          .success,
      ).toBe(false);
      await client.ping();
    } finally {
      try {
        await client.close();
      } finally {
        await transport.close();
      }
    }
  },
  30_000,
);
