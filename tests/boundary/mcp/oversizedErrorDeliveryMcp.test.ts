import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { STDIO_DEFAULT_MAX_BUFFER_SIZE } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { z } from "zod";

import { AnalysisInputError } from "../../../src/domain/analysisErrorCore.js";
import type { AnalysisError } from "../../../src/domain/analysisErrorBase.js";
import type { AnalysisOperationPort } from "../../../src/application/AnalysisProvider.js";
import { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { AnalysisProviderRegistry } from "../../../src/application/binary/AnalysisProviderRegistry.js";
import { SessionProviderRouter } from "../../../src/application/binary/SessionProviderRouter.js";
import type { EvidenceWriter } from "../../../src/application/investigation/InvestigationRecordPort.js";
import { EvidenceIntegrityError } from "../../../src/domain/evidenceErrors.js";
import type { Evidence } from "../../../src/domain/evidence.js";
import { err, ok, type Result } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { ToolResultDelivery } from "../../../src/server/toolResult.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { attachNonexecutingMcpFixture } from "../../support/investigation/ownedMcpFixture.js";

const delivery = new ToolResultDelivery(STDIO_DEFAULT_MAX_BUFFER_SIZE);

const errorWithName = (nameBytes: number) =>
  new AnalysisInputError("procedure_address", undefined, [
    {
      path: ["procedure"],
      reason: "invalid_value",
      message: `Unknown Ghidra procedure name or address: REA_MISSING_${"x".repeat(nameBytes)}`,
    },
  ]);

const failureWithName = (nameBytes: number) =>
  delivery.toErrorToolResult(errorWithName(nameBytes));

/** Inert recording owner: no targets or providers are ever opened. */
class ErrorRecordingSession extends BinarySession {
  constructor(
    private readonly error: AnalysisInputError,
    private readonly writer: EvidenceWriter["recordEvidence"],
  ) {
    super(
      SessionProviderRouter.selectable(new AnalysisProviderRegistry([]), []),
    );
  }

  override execute: AnalysisOperationPort["execute"] = () =>
    Promise.resolve(err(this.error));

  override async withAdmittedAnalysis<Value>(
    _operation: string,
    _signal: AbortSignal | undefined,
    callback: (analysis: AnalysisOperationPort) => Promise<Value>,
  ): Promise<Result<Value, AnalysisError>> {
    return ok(await callback(this));
  }

  override recordEvidence(evidence: Evidence) {
    return this.writer(evidence);
  }
}

// Production handlers replace custom synthetic tool names. This covers error
// transport and retention through the real factory, not arbitrary registration.
const createErrorFixture = async (
  nameBytes: number,
  writer?: EvidenceWriter["recordEvidence"],
) => {
  const error = errorWithName(nameBytes);
  const session =
    writer === undefined ? undefined : new ErrorRecordingSession(error, writer);
  const analysis: AnalysisOperationPort = {
    execute: (operation) =>
      Promise.resolve(
        operation === "list_documents"
          ? observed(["still connected"])
          : err(error),
      ),
  };
  const port = session ?? analysis;
  const server = createServer(
    session === undefined
      ? { kind: "fixed", analysis }
      : { kind: "session", session },
    { environment: {}, delivery },
  );
  const failureRequest = {
    name: "procedure_address",
    arguments: { procedure: "controller-owned-error-fixture" },
  };
  const healthyRequest =
    session === undefined
      ? { name: "list_documents" as const, arguments: {} }
      : { name: "close_binary" as const, arguments: {} };
  await attachNonexecutingMcpFixture(server, port, [
    failureRequest,
    healthyRequest,
  ]);
  return { server, session, failureRequest, healthyRequest };
};

// The delivered error carries its JSON once, as text, so only a diagnostic
// larger than the whole budget is oversized.
const oversizedFailure = () =>
  failureWithName(STDIO_DEFAULT_MAX_BUFFER_SIZE + 64 * 1024);

const exerciseDeliveryFailure = async (
  recordEvidence: EvidenceWriter["recordEvidence"] | undefined,
  retention: "retained" | "unavailable" | "failed",
) => {
  const { server, session, failureRequest, healthyRequest } =
    await createErrorFixture(
      STDIO_DEFAULT_MAX_BUFFER_SIZE + 64 * 1024,
      recordEvidence,
    );
  const client = new Client({ name: "oversized-error-client", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const failure = await client.callTool(failureRequest);
    expect(failure.isError).toBe(true);
    expect(failure.structuredContent).toBeUndefined();
    expect(parseMcpToolError(failure)).toMatchObject({
      error: {
        code: "resource_constraint",
        details: {
          reported_limits: {
            original_error_code: "invalid_request",
          },
        },
      },
    });
    const reportedLimits = z
      .object({
        error: z.object({
          code: z.literal("resource_constraint"),
          details: z.object({
            reported_limits: z.record(z.string(), z.unknown()),
          }),
        }),
      })
      .parse(parseMcpToolError(failure)).error.details.reported_limits;
    expect(parseMcpToolError(failure)).toMatchObject({
      error: {
        details: {
          reported_limits: {
            boundary: "mcp-response",
          },
        },
      },
    });
    if (retention === "retained") {
      expect(reportedLimits.evidence_reference).toMatchObject({
        kind: "retained-evidence",
        evidence_id: expect.any(String),
      });
      expect(reportedLimits).not.toHaveProperty("retention");
    } else {
      expect(reportedLimits).not.toHaveProperty("evidence_reference");
      expect(reportedLimits.retention).toBe(retention);
    }
    if (retention === "failed")
      expect(reportedLimits.retention_error).toMatchObject({
        code: "evidence_integrity_mismatch",
      });
    expect(Buffer.byteLength(JSON.stringify(failure))).toBeLessThan(
      STDIO_DEFAULT_MAX_BUFFER_SIZE,
    );

    await client.ping();
    const healthy = await client.callTool(healthyRequest);
    expect(healthy.isError).not.toBe(true);
    const healthyResult = toolContract(healthyRequest.name).outputSchema.parse(
      healthy.structuredContent,
    );
    if (session === undefined)
      expect(healthyResult).toMatchObject({
        normalized_result: ["still connected"],
      });
  } finally {
    await Promise.all([client.close(), server.close()]);
    await session?.close();
  }
};

it("keeps the SDK connection usable when oversized-error retention is unavailable or fails", async () => {
  await exerciseDeliveryFailure(undefined, "unavailable");
  await exerciseDeliveryFailure(
    () =>
      err(
        new EvidenceIntegrityError(
          "fixture ledger rejected the Evidence record",
        ),
      ),
    "failed",
  );
});

it("retains the complete oversized diagnostic before removing its private structured carrier", async () => {
  const retained: Evidence[] = [];
  await exerciseDeliveryFailure((evidence) => {
    retained.push(evidence);
    return ok("added");
  }, "retained");
  expect(retained).toHaveLength(1);
  expect(retained[0]?.normalized_result).toEqual(
    oversizedFailure().structuredContent,
  );
  expect(retained[0]?.raw_result).toEqual(oversizedFailure());
});

it("delivers an error whose text fits although structured and text copies would not", async () => {
  const nameBytes = Math.ceil(STDIO_DEFAULT_MAX_BUFFER_SIZE / 2) + 64 * 1024;
  const retained: Evidence[] = [];
  const { server, session, failureRequest } = await createErrorFixture(
    nameBytes,
    (evidence) => {
      retained.push(evidence);
      return ok("added");
    },
  );
  const client = new Client({ name: "mid-sized-error-client", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const failure = await client.callTool(failureRequest);
    expect(failure.isError).toBe(true);
    expect(failure.structuredContent).toBeUndefined();
    expect(parseMcpToolError(failure)).toEqual(
      failureWithName(nameBytes).structuredContent,
    );
    expect(retained).toHaveLength(0);
    expect(Buffer.byteLength(JSON.stringify(failure))).toBeLessThan(
      STDIO_DEFAULT_MAX_BUFFER_SIZE,
    );
  } finally {
    await Promise.all([client.close(), server.close()]);
    await session?.close();
  }
});
