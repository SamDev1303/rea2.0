import { retainOwnedServiceEvidence } from "../../fixtures/ownedServiceEvidence.js";
import { assertOwnedFixturePublicDenial } from "../../fixtures/ownedArtifactProducer.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished, vi } from "vitest";
import { WebRuntimeService } from "../../../src/application/WebRuntimeService.js";
import { recordingWebRuntimePort } from "../../../src/application/WebRuntimeService.fixture.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

it("advertises actual SDK schemas, instrumentation effects and retained direct recording-service Evidence with public runtime denied", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("Binary provider must not start");
  });
  const port = recordingWebRuntimePort();
  const observed = vi.spyOn(port, "observeExecution");
  const inspected = vi.spyOn(port, "inspectEventListeners");
  const service = new WebRuntimeService(port);
  const server = createServer(
    { kind: "session", session },
    {
      webRuntime: service,
    },
  );
  const client = new Client({ name: "web-runtime-contract", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const tools = (await client.listTools()).tools;
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const input = {
    cdp_endpoint: "http://127.0.0.1:9222",
    target_id: "allowed-page",
    observation_ms: 5,
  };
  for (const name of [
    "observe_web_execution",
    "inspect_web_event_listeners",
  ] as const) {
    const advertised = tools.find((tool) => tool.name === name);
    if (advertised?.outputSchema === undefined)
      throw new Error(`Missing advertised runtime schemas: ${name}`);
    const inputSchema: Record<string, unknown> = advertised.inputSchema;
    const outputSchema: Record<string, unknown> = advertised.outputSchema;
    expect(ajv.validateSchema(inputSchema)).toBe(true);
    expect(ajv.validateSchema(outputSchema)).toBe(true);
    const args =
      name === "observe_web_execution"
        ? input
        : {
            cdp_endpoint: "http://127.0.0.1:9222",
            target_id: "allowed-page",
            selector: "#selected",
          };
    expect(ajv.validate(inputSchema, args)).toBe(true);
    await assertOwnedFixturePublicDenial(client, name, args);
    const selected = name === "observe_web_execution" ? observed : inspected;
    expect(selected).not.toHaveBeenCalled();
    const response = await retainOwnedServiceEvidence(
      session,
      client,
      await (name === "observe_web_execution"
        ? service.observe(args)
        : service.inspect(args)),
    );
    expect(
      ajv.validate(outputSchema, response),
      JSON.stringify(ajv.errors),
    ).toBe(true);
    const parsed = toolContract(name).outputSchema.parse(response);
    const evidence = parseEvidence(parsed);
    expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
  }
  expect(toolContract("observe_web_execution").effects).toMatchObject({
    mutatesTarget: true,
    mayDiscardData: true,
    idempotent: false,
  });
  const invalid = await client.callTool({
    name: "observe_web_execution",
    arguments: { ...input, observation_ms: 2_147_483_648 },
  });
  expect(invalid.isError).toBe(true);
});
