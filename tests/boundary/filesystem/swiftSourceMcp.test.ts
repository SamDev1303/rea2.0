import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createServer } from "../../../src/server/createServer.js";
import { silentLogger } from "../../../src/logger.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";

it("advertises, executes and retains real Swift Evidence through the public MCP contract", async () => {
  const root = await createTestTempDirectory("rea-swift-mcp-");
  await writeFile(
    join(root, "Recorder.swift"),
    "import Foundation\nactor Recorder { func stop() { cancel() } }",
  );
  const session = createTestBinarySession(() => {
    throw new Error("Swift mapping must not start a native provider");
  });
  const server = createServer(
    { kind: "session", session },
    { environment: {}, logger: silentLogger },
  );
  const client = new Client({ name: "owned-swift-source-proof", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const catalog = await client.listTools();
    expect(
      catalog.tools.find((item) => item.name === "analyze_swift_application"),
    ).toBeDefined();
    const response = await client.callTool({
      name: "analyze_swift_application",
      arguments: { input_path: root },
    });
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    const evidence = toolContract(
      "analyze_swift_application",
    ).outputSchema.parse(response.structuredContent);
    expect(evidence.normalized_result.files[0]!.call_candidates[0]!.name).toBe(
      "cancel",
    );
    const retained = await client.callTool({
      name: "get_evidence_bundle",
      arguments: {},
    });
    const bundle = toolContract("get_evidence_bundle").outputSchema.parse(
      retained.structuredContent,
    ).result;
    expect(
      bundle.records?.some(
        (record) => record.evidence_id === evidence.evidence_id,
      ),
    ).toBe(true);
    const denied = await client.callTool({
      name: "analyze_swift_application",
      arguments: { input_path: join(root, ".env") },
    });
    expect(denied.isError).toBe(true);
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
});
