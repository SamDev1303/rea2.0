import { retainOwnedServiceEvidence } from "../../fixtures/ownedServiceEvidence.js";
import {
  assertOwnedFixturePublicDenial,
  projectOwnedProducerError,
} from "../../fixtures/ownedArtifactProducer.js";
import { JebAnalysisService } from "../../../src/application/jeb/JebAnalysisService.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished, vi } from "vitest";

import type { JebAnalysisPort } from "../../../src/application/jeb/JebAnalysisPort.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";

const identity = { id: "jeb", name: "JEB", version: "5.48.0" } as const;

it("advertises exact valid JEB schemas and retains direct inert-provider Evidence through MCP while public execution is denied", async () => {
  const execution = createAnalysisExecution(
    {
      engine: {
        name: "jeb",
        version: "5.48.0",
        endpoint: "http://127.0.0.1:8425/mcp",
        gui_client: false,
      },
      startup_ts: 1791623439,
      message: null,
    },
    identity,
  );
  const provider: JebAnalysisPort = {
    async inspectAvailability() {
      return { status: "available", code: null, reason: null, diagnostics: {} };
    },
    async close() {},
    async execute() {
      return ok(execution);
    },
  };
  const executed = vi.spyOn(provider, "execute");
  const service = new JebAnalysisService(provider);
  const session = createTestBinarySession(() => {
    throw new Error("deep provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    { jebAnalysis: provider },
  );
  const client = new Client({ name: "jeb-contract", version: "1" });
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
    (tool) => tool.name === "inspect_jeb_client",
  );
  if (advertised?.inputSchema === undefined)
    throw new Error("JEB tools must publish both schemas");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  expect(ajv.validateSchema(advertised.inputSchema)).toBe(true);
  const outputSchema: Record<string, unknown> = advertised.outputSchema ?? {};
  expect(ajv.validateSchema(outputSchema)).toBe(true);
  expect(ajv.validate(advertised.inputSchema, {})).toBe(true);
  expect(ajv.validate(advertised.inputSchema, { unexpected: 1 })).toBe(false);

  const input = {};
  await assertOwnedFixturePublicDenial(client, "inspect_jeb_client", input);
  expect(executed).not.toHaveBeenCalled();
  const evidence = await retainOwnedServiceEvidence(
    session,
    client,
    await service.execute("inspect_jeb_client", input),
  );
  expect(evidence.provider.id).toBe("jeb");
  expect(evidence.normalized_result).toEqual(execution.result);
});

it("preserves direct JEB provider failure reasons while MCP blocks execution before the provider", async () => {
  const contract = toolContract("list_jeb_units");
  const provider: JebAnalysisPort = {
    async inspectAvailability() {
      return { status: "available", code: null, reason: null, diagnostics: {} };
    },
    async close() {},
    async execute() {
      return ok(
        createAnalysisExecution(
          { engine: null, units: [], coverage: "complete" } as never,
          identity,
        ),
      );
    },
  };
  void contract;
  const unavailable: JebAnalysisPort = {
    ...provider,
    async execute() {
      const { AnalysisCapabilityUnavailableError } =
        await import("../../../src/domain/analysisErrorCore.js");
      return {
        ok: false as const,
        error: new AnalysisCapabilityUnavailableError(
          "jeb",
          "list_jeb_units",
          "connect ECONNREFUSED 127.0.0.1:8425",
          {
            userMessage:
              "Start a JEB client serving MCP (default http://127.0.0.1:8425/mcp) or set REA_JEB_MCP_URL to the running endpoint.",
          },
        ),
      };
    },
  };
  const executed = vi.spyOn(unavailable, "execute");
  const service = new JebAnalysisService(unavailable);
  const session = createTestBinarySession(() => {
    throw new Error("deep provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    { jebAnalysis: unavailable },
  );
  const client = new Client({ name: "jeb-failure", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  await assertOwnedFixturePublicDenial(client, "list_jeb_units", {});
  expect(executed).not.toHaveBeenCalled();
  const failure = projectOwnedProducerError(
    await service.execute("list_jeb_units", {}),
  );
  const text = JSON.stringify(failure);
  expect(text).toContain("ECONNREFUSED");
  expect(text).toContain("REA_JEB_MCP_URL");
});
