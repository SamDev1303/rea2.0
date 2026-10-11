import { attachNonexecutingMcpFixture } from "../../support/investigation/ownedMcpFixture.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { ok as resultOk } from "../../../src/domain/result.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";

import { createDeferred } from "../../fixtures/binarySession.js";
import type { OwnedMcpFixtureRequest } from "../../support/investigation/ownedMcpFixture.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import type {
  AnalysisClient,
  AnalysisOperationPort,
} from "../../../src/application/AnalysisProvider.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";
import { createServer } from "../../../src/server/createServer.js";
import { TOOL_CONTRACTS } from "../../../src/contracts/toolContracts.js";
import { toolAvailability } from "../../../src/contracts/toolOutputSchemaPrimitives.js";

const resources: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(
    resources.splice(0).map(async (resource) => resource.close()),
  );
});

const connect = async (
  analysis: AnalysisOperationPort,
  requests: readonly OwnedMcpFixtureRequest[] = [
    { name: "list_procedures", arguments: {} },
    { name: "procedure_pseudo_code", arguments: { procedure: "0x1000" } },
    { name: "xrefs", arguments: {} },
  ],
) => {
  const server = createServer({ kind: "fixed", analysis });
  await attachNonexecutingMcpFixture(server, analysis, requests);
  const client = new Client({
    name: "integration-test",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
};

const structured = (result: CallToolResult): Record<string, unknown> => {
  if (result.isError === true) return parseMcpToolError(result);
  if (
    typeof result.structuredContent !== "object" ||
    result.structuredContent === null
  )
    throw new Error("missing structured result");
  return Object.fromEntries(Object.entries(result.structuredContent));
};

it("executes a realistic workflow: list methods, decompile selected, get xrefs", async () => {
  const client = await connect({
    execute: (name, args) => {
      switch (name) {
        case "list_procedures":
          return Promise.resolve(
            ok([
              { address: "0x1000", value: "main" },
              { address: "0x2000", value: "helper" },
            ]),
          );
        case "procedure_pseudo_code":
          return Promise.resolve(
            ok(`pseudo for ${(args as { procedure: string }).procedure}`),
          );
        case "xrefs":
          return Promise.resolve(ok(["0x1000"]));
        default:
          return Promise.resolve(ok(null));
      }
    },
  });

  const listResult = await client.callTool({
    name: "list_procedures",
    arguments: {},
  });
  expect(listResult.isError).not.toBe(true);
  expect(structured(listResult)).toMatchObject({
    normalized_result: [
      { address: "0x1000", value: "main" },
      { address: "0x2000", value: "helper" },
    ],
  });

  const decompileResult = await client.callTool({
    name: "procedure_pseudo_code",
    arguments: { procedure: "0x1000" },
  });
  expect(structured(decompileResult)).toMatchObject({
    normalized_result: "pseudo for 0x1000",
  });

  const xrefResult = await client.callTool({
    name: "xrefs",
    arguments: {},
  });
  expect(structured(xrefResult)).toMatchObject({
    normalized_result: ["0x1000"],
  });
});

it("advertises the complete currently available inventory with a session", async () => {
  const session = createTestBinarySession(
    (_path) =>
      ({
        execute: () => Promise.resolve(ok(null)),
        close: () => Promise.resolve(resultOk(null)),
      }) satisfies AnalysisClient,
  );
  const server = createServer({ kind: "session", session });
  const client = new Client({
    name: "integration-test",
    version: "1.0.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const listed = await client.listTools();
  const names = listed.tools.map((t) => t.name);
  const status = structured(
    await client.callTool({
      name: "binary_session",
      arguments: {},
    }),
  );
  const inventory = z
    .object({
      result: z.object({ tool_availability: z.array(toolAvailability) }),
    })
    .parse(status).result.tool_availability;
  for (const availability of inventory) {
    if (availability.available) continue;
    expect(availability.reason).not.toBe("available");
    expect(
      availability.remediation?.trim().length,
      availability.name,
    ).toBeGreaterThan(0);
  }
  const available = new Set(
    inventory.filter((item) => item.available).map(({ name }) => name),
  );
  expect(new Set(names)).toEqual(
    new Set(TOOL_CONTRACTS.map(({ name }) => name)),
  );
  expect(available).not.toContain("binary_overview");
  expect(available).not.toContain("batch_decompile");

  const contracts = new Map<string, (typeof TOOL_CONTRACTS)[number]>(
    TOOL_CONTRACTS.map((contract) => [contract.name, contract]),
  );
  for (const tool of listed.tools) {
    const contract = contracts.get(tool.name);
    expect(contract, tool.name).toBeDefined();
    expect(tool.title, tool.name).toBe(contract?.title);
    expect(tool.description, tool.name).toBe(contract?.description);
    expect(tool.annotations, tool.name).toEqual(contract?.annotations);
    expect(tool.inputSchema, tool.name).toBeDefined();
    expect(tool.outputSchema, tool.name).toBeDefined();
  }
}, 10_000);

it("orders admissions without waiting for an already-running recording analysis", async () => {
  const entered = createDeferred<void>();
  const release = createDeferred<ReturnType<typeof ok>>();
  let firstSettled = false;
  const client = await connect(
    {
      execute: (_operation, args) => {
        if (args.address === "0x1000") {
          entered.resolve();
          return release.promise;
        }
        return Promise.resolve(ok("second completed"));
      },
    },
    [
      { name: "address_name", arguments: { address: "0x1000" } },
      { name: "address_name", arguments: { address: "0x1001" } },
    ],
  );
  const first = client
    .callTool({ name: "address_name", arguments: { address: "0x1000" } })
    .then((result) => {
      firstSettled = true;
      return result;
    });
  try {
    await entered.promise;
    const second = await client.callTool({
      name: "address_name",
      arguments: { address: "0x1001" },
    });
    expect(second.isError).not.toBe(true);
    expect(structured(second)).toMatchObject({
      normalized_result: "second completed",
    });
    expect(firstSettled).toBe(false);
    release.resolve(ok("first completed"));
    expect(structured(await first)).toMatchObject({
      normalized_result: "first completed",
    });
  } finally {
    release.resolve(ok("first completed"));
    await first;
  }
});
