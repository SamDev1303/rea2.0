import type { ServerContext } from "@modelcontextprotocol/server";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { z } from "zod";
import { captureInvestigationDispatchContext } from "./InvestigationDispatchContext.js";
import { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { ToolResultDelivery } from "./toolResult.js";

it("captures protocol metadata and signal identity while preserving real cancellation", () => {
  const controller = new AbortController();
  const original = {
    sessionId: "owned-session",
    mcpReq: {
      id: "request-one",
      method: "tools/call",
      signal: controller.signal,
      _meta: { progressToken: "original" },
      inputResponses: { choice: { path: "/owned/fixture" } },
    },
  } as unknown as ServerContext;
  const selected = captureInvestigationDispatchContext(
    "read_evidence",
    original,
  );
  Reflect.set(original.mcpReq, "signal", new AbortController().signal);
  Reflect.set(original.mcpReq, "_meta", { progressToken: "changed" });
  expect(selected.mcpReq._meta?.progressToken).toBe("original");
  expect(Reflect.set(selected, "mcpReq", original.mcpReq)).toBe(false);
  expect(Reflect.set(selected.mcpReq, "signal", original.mcpReq.signal)).toBe(
    false,
  );
  expect(
    Reflect.set(
      selected.mcpReq.inputResponses?.choice as object,
      "path",
      "/outside",
    ),
  ).toBe(false);
  controller.abort();
  expect(selected.mcpReq.signal.aborted).toBe(true);
});

it("admits large public protocol metadata through the registered MCP wrapper without fixture authority", async () => {
  const server = new EvidenceMcpServer(
    { name: "public-context-regression", version: "1" },
    {},
    undefined,
    new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE),
  );
  const bytes = 1024 * 1024 + 1;
  let calls = 0;
  server.registerTool(
    "get_evidence_bundle",
    { inputSchema: z.object({}) },
    (_input, context) => {
      calls++;
      expect(context.mcpReq._meta?.["proof"]).toHaveLength(bytes);
      expect(Object.isFrozen(context.mcpReq._meta)).toBe(true);
      return { content: [{ type: "text", text: "wrapper reached" }] };
    },
  );
  const client = new Client({ name: "public-context-client", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st);
    await client.connect(ct);
    const result = await client.callTool({
      name: "get_evidence_bundle",
      arguments: {},
      _meta: { proof: "x".repeat(bytes) },
    });
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "wrapper reached" }]);
    expect(calls).toBe(1);
  } finally {
    await client.close();
    await server.close();
  }
});
