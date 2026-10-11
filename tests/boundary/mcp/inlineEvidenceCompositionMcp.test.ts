import { describe, expect, it } from "vitest";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { ghidraFunctionDossier } from "../../../src/domain/ghidraValues.fixture.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { attachNonexecutingMcpFixture } from "../../support/investigation/ownedMcpFixture.js";

/** Target-free recording session with real Evidence retention and no file/provider acquisition. */
const connectRecordingMcp = async () => {
  const calls: string[] = [];
  const session = createTestBinarySession(() => {
    throw new Error("Inline composition must not acquire a deep provider");
  });
  session.open = async () => {
    throw new Error("Inline composition must not acquire target bytes");
  };
  session.execute = async (operation) => {
    if (operation !== "analyze_function")
      throw new Error(`Unexpected recording operation ${operation}`);
    calls.push(operation);
    return ok(
      createAnalysisExecution(
        ghidraFunctionDossier(),
        { id: "fixture", name: "Recording fixture", version: "1" },
        {
          subject: {
            path: "/fixtures/inline-function.exe",
            format: "pe",
            sha256: "a".repeat(64),
          },
        },
      ),
    );
  };
  session.withAdmittedAnalysis = async (_name, _signal, execute) =>
    ok(await execute(session));
  const server = createServer(
    { kind: "session", session },
    { environment: {} },
  );
  const mcp = new Client({ name: "inline-function-evidence", version: "1" });
  const close = async () => {
    await Promise.allSettled([mcp.close(), server.close()]);
    await session.close();
  };
  try {
    await attachNonexecutingMcpFixture(server, session, [
      { name: "analyze_function", arguments: { procedure: "fixture_main" } },
    ]);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);
  } catch (cause: unknown) {
    await close();
    throw cause;
  }
  return { mcp, session, calls, close };
};

describe("inline MCP Evidence composition", () => {
  it("feeds returned function Evidence directly to comparison and matches the bundle", async () => {
    const harness = await connectRecordingMcp();
    const { mcp, session } = harness;
    try {
      const response = await mcp.callTool({
        name: "analyze_function",
        arguments: { procedure: "fixture_main" },
      });
      expect(response.isError).not.toBe(true);
      const analyzed = toolContract("analyze_function").outputSchema.parse(
        response.structuredContent,
      );
      const comparison = await mcp.callTool({
        name: "compare_functions",
        arguments: { left: analyzed, right: analyzed },
      });
      expect(comparison.isError, JSON.stringify(comparison)).not.toBe(true);
      const inline = parseEvidence(analyzed);
      expect(inline.normalized_result).toEqual(analyzed.normalized_result);
      expect(session.evidenceById(inline.evidence_id)).toEqual(inline);
      const compared = toolContract("compare_functions").outputSchema.parse(
        comparison.structuredContent,
      );
      const comparisonEvidence = parseEvidence(compared);
      expect(comparisonEvidence.evidence_links).toContain(inline.evidence_id);
      expect(comparisonEvidence.normalized_result).toEqual(
        compared.normalized_result,
      );
      const bundle = await mcp.callTool({
        name: "get_evidence_bundle",
        arguments: {},
      });
      const exported = toolContract("get_evidence_bundle").outputSchema.parse(
        bundle.structuredContent,
      );
      const retained = parseEvidenceBundle(exported.result);
      expect(retained.records).toContainEqual(inline);
      expect(retained.records).toContainEqual(comparisonEvidence);
      expect(harness.calls).toEqual(["analyze_function"]);
    } finally {
      await harness.close();
    }
  });
});
