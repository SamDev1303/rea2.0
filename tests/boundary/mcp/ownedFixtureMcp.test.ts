import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { attachNonexecutingMcpFixture } from "../../support/investigation/ownedMcpFixture.js";

const connect = async (
  actual: AnalysisOperationPort,
  bound: object = actual,
) => {
  const server = createServer({ kind: "fixed", analysis: actual });
  try {
    await attachNonexecutingMcpFixture(server, bound, [
      { name: "address_name", arguments: { address: "0x1000" } },
    ]);
  } catch (cause) {
    await server.close();
    throw cause;
  }
  const client = new Client({ name: "owned-recording-fixture", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  onTestFinished(async () => {
    await Promise.all([client.close(), server.close()]);
  });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
};

describe("sealed nonexecuting MCP fixtures", () => {
  it("executes only the exact controller-authored operation and input", async () => {
    const execute = vi.fn(() => Promise.resolve(observed("fixture-main")));
    const client = await connect({ execute });
    expect(
      (
        await client.callTool({
          name: "address_name",
          arguments: { address: "0x1000" },
        })
      ).isError,
    ).not.toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    for (const request of [
      { name: "address_name", arguments: { address: "0x2000" } },
      { name: "list_documents", arguments: {} },
      { name: "address_name", arguments: { address: "0x1000", trusted: true } },
    ])
      expect((await client.callTool(request)).isError).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects a token attached with a port different from the factory's selected port", async () => {
    const actual = {
      execute: vi.fn(() => Promise.resolve(observed("actual"))),
    };
    const unrelated = {
      execute: vi.fn(() => Promise.resolve(observed("unrelated"))),
    };
    await expect(connect(actual, unrelated)).rejects.toThrow(
      "No matching sealed controller-owned fixture capability",
    );
    expect(actual.execute).not.toHaveBeenCalled();
    expect(unrelated.execute).not.toHaveBeenCalled();
  });
});
