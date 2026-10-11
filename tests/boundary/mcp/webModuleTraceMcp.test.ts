import { retainOwnedServiceEvidence } from "../../fixtures/ownedServiceEvidence.js";
import { assertOwnedFixturePublicDenial } from "../../fixtures/ownedArtifactProducer.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished, vi } from "vitest";
import { WebModuleTraceService } from "../../../src/application/WebModuleTraceService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import {
  webModuleArtifactsFixture,
  webModuleResolverFixture,
} from "../../fixtures/webModuleTrace.js";

it("publishes valid SDK schemas and retains the direct synthetic module trace through MCP with public execution denied", async () => {
  const artifacts = webModuleArtifactsFixture();
  const service = new WebModuleTraceService(
    { load: vi.fn(() => Promise.resolve(ok(artifacts))) },
    webModuleResolverFixture,
  );
  const session = createTestBinarySession(() => {
    throw new Error("binary provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    { webModuleTrace: service },
  );
  const client = new Client({ name: "module-contract", version: "1" });
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
    (tool) => tool.name === "trace_web_module_imports",
  );
  if (advertised?.outputSchema === undefined)
    throw new Error("module trace must advertise both schemas");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const inputSchema: Record<string, unknown> = advertised.inputSchema;
  const outputSchema: Record<string, unknown> = advertised.outputSchema;
  const args = { manifest_path: "/analysis/manifest.json", script_index: 0 };
  expect(ajv.validate(inputSchema, args)).toBe(true);
  await assertOwnedFixturePublicDenial(
    client,
    "trace_web_module_imports",
    args,
  );
  expect(service.artifacts.load).not.toHaveBeenCalled();
  const response = await retainOwnedServiceEvidence(
    session,
    client,
    await service.trace(args),
  );
  expect(ajv.validate(outputSchema, response), JSON.stringify(ajv.errors)).toBe(
    true,
  );
  const parsed = toolContract("trace_web_module_imports").outputSchema.parse(
    response,
  );
  const evidence = parseEvidence(parsed);
  expect(evidence.normalized_result).toMatchObject({
    importer: {
      url: artifacts.manifest.scripts[0]?.url,
      basis: "reported-source-url",
    },
    imports: [
      {
        resolution: { state: "resolved", url: "https://app.test/dep.js" },
        execution: "unknown",
      },
      {
        resolution: { state: "unknown", reason: "computed-specifier" },
        execution: "unknown",
      },
    ],
  });
  expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
  const invalid = await client.callTool({
    name: "trace_web_module_imports",
    arguments: { ...args, manifest_path: "relative.json" },
  });
  expect(invalid.isError).toBe(true);
});
