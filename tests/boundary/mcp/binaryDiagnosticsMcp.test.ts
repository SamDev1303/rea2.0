import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";
import { BinaryLayoutService } from "../../../src/application/binaryDiagnostics/BinaryLayoutService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import {
  binaryLayoutFixture,
  BINARY_LAYOUT_TEST_PROVIDER,
} from "../../fixtures/binaryDiagnostics/layout.js";

it("advertises exact schemas, rejects public layout parsing and views retained synthetic producer Evidence", async () => {
  const value = binaryLayoutFixture();
  let producerCalls = 0;
  const service = new BinaryLayoutService({
    identity: BINARY_LAYOUT_TEST_PROVIDER,
    inspect: () => {
      producerCalls += 1;
      return Promise.resolve(ok(value));
    },
  });
  const session = createTestBinarySession(() => {
    throw new Error("deep provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    { binaryLayout: service },
  );
  const client = new Client({ name: "binary-layout-contract", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const advertised = (await client.listTools()).tools.find(
    (tool) => tool.name === "inspect_binary_layout",
  );
  if (advertised?.outputSchema === undefined)
    throw new Error("layout must publish both schemas");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const inputSchema: Record<string, unknown> = advertised.inputSchema;
  const outputSchema: Record<string, unknown> = advertised.outputSchema;
  expect(ajv.validateSchema(inputSchema)).toBe(true);
  expect(ajv.validateSchema(outputSchema)).toBe(true);
  expect(ajv.validate(inputSchema, { path: value.artifact.path })).toBe(true);
  expect(
    ajv.validate(inputSchema, {
      path: value.artifact.path,
      approval: true,
    }),
  ).toBe(false);
  const denied = await client.callTool({
    name: "inspect_binary_layout",
    arguments: { path: value.artifact.path },
  });
  expect(denied.isError).toBe(true);
  expect(parseMcpToolError(denied)).toMatchObject({
    error: {
      code: "capability_unavailable",
      details: {
        operation: "inspect_binary_layout",
        provider_id: "rea2-protected-host",
      },
    },
  });
  expect(session.activeTarget()).toBeUndefined();
  expect(producerCalls).toBe(0);
  // The controller-owned port produces observations directly; this is not a successful public layout receipt.
  const produced = await service.inspect({ path: value.artifact.path });
  expect(produced.ok).toBe(true);
  if (!produced.ok) throw produced.error;
  expect(producerCalls).toBe(1);
  expect(
    ajv.validate(outputSchema, produced.value),
    JSON.stringify(ajv.errors),
  ).toBe(true);
  const parsed = toolContract("inspect_binary_layout").outputSchema.parse(
    produced.value,
  );
  expect(session.recordEvidence(produced.value).ok).toBe(true);
  const evidence = parseEvidence(parsed);
  expect(evidence.confidence).toBe("observed");
  expect(evidence.raw_result).toBeNull();
  expect(evidence.parameters).toMatchObject({ path: value.artifact.path });
  expect(evidence.subject?.digest.sha256).toBe(value.artifact.sha256);
  expect(parsed.normalized_result).toEqual(value);
  expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
  const invalid = await service.inspect({ path: "relative.elf" });
  expect(invalid).toMatchObject({
    ok: false,
    error: { _tag: "AnalysisInputError", operation: "inspect_binary_layout" },
  });
  const viewed = await client.callTool({
    name: "inspect_analysis_view",
    arguments: {
      source: {
        kind: "retained-evidence",
        evidence_id: evidence.evidence_id,
      },
      view: { kind: "summary" },
    },
  });
  expect(viewed.isError).not.toBe(true);
  expect(
    toolContract("inspect_analysis_view").outputSchema.parse(
      viewed.structuredContent,
    ).normalized_result,
  ).toMatchObject({
    kind: "summary",
    parent_evidence_id: evidence.evidence_id,
    summary: { format: "elf", bytes: value.artifact.bytes },
  });
  expect(
    (
      await client.callTool({
        name: "inspect_binary_layout",
        arguments: { path: "relative.elf" },
      })
    ).isError,
  ).toBe(true);
});
