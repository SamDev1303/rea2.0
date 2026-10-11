import { attachNonexecutingMcpFixture } from "../../support/investigation/ownedMcpFixture.js";
import type { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { readAnalysisSnapshot } from "../../../src/application/binary/AnalysisSnapshotFiles.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { expect } from "vitest";
import { z } from "zod";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import {
  createEvidenceBundle,
  evidenceBundleSchema,
} from "../../../src/domain/evidenceBundle.js";
import { ok } from "../../../src/domain/result.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import type { AnalysisProvider } from "../../../src/application/AnalysisProvider.js";

const SNAPSHOT_PROFILE = createAnalysisProfile(
  { id: "fixture", name: "Fixture analysis provider", version: "1" },
  { fixture: true },
);

export interface SessionMcpHarness {
  readonly mcp: Client;
  readonly session: BinarySession;
  readonly first: string;
  readonly second: string;
  readonly closed: string[];
}

export const createSessionMcpHarness = async (
  root: string,
  provider: (closed: string[]) => AnalysisProvider,
  resources: Array<{ close(): Promise<unknown> }>,
): Promise<SessionMcpHarness> => {
  const first = join(root, "first.hop");
  const second = join(root, "second.hop");
  await Promise.all([writeFile(first, "one"), writeFile(second, "two")]);
  const closed: string[] = [];
  const session = createTestBinarySession(provider(closed), {
    resolveAnalysisProfile: () =>
      Promise.resolve(ok({ profile: SNAPSHOT_PROFILE })),
  });
  const server = createServer(
    { kind: "session", session },
    {
      logger: silentLogger,
    },
  );
  await attachNonexecutingMcpFixture(server, session, [
    { name: "current_document", arguments: {} },
    {
      name: "address_name",
      arguments: { address: "0x1000", document: "fixture" },
    },
    {
      name: "address_name",
      arguments: { address: "0x1001", document: "fixture" },
    },
  ]);
  const mcp = new Client({ name: "session-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(mcp, server);
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  return {
    mcp,
    session,
    first,
    second,
    closed,
  };
};

export const snapshotAndRecordUnknown = async (
  harness: SessionMcpHarness,
  root: string,
): Promise<{
  recordedUnknown: { unknown_id: string; revision: number };
}> => {
  const { mcp } = harness;
  const snapshotted = await mcp.callTool({
    name: "get_evidence_bundle",
    arguments: {},
  });
  expect(structured(snapshotted).result).toMatchObject({
    records: expect.any(Array),
    unknowns: expect.any(Array),
  });
  const evidencePath = join(root, "evidence.json");
  structured(
    await mcp.callTool({
      name: "export_evidence_bundle",
      arguments: { path: evidencePath },
    }),
  );
  const bundle = evidenceBundleSchema.parse(
    JSON.parse(await readFile(evidencePath, "utf8")),
  );
  expect(bundle.records).toHaveLength(1);
  expect(
    structured(
      await mcp.callTool({
        name: "import_evidence_bundle",
        arguments: { path: evidencePath },
      }),
    ).result,
  ).toEqual({ imported: 0, unknowns_added: 0, total: 1 });
  const externalEvidencePath = join(root, "external-evidence.json");
  await writeFile(
    externalEvidencePath,
    JSON.stringify(
      createEvidenceBundle([
        createEvidence(
          undefined,
          { id: "fixture", name: "Fixture", version: "1" },
          { operation: "external_observation", parameters: {}, result: true },
        ),
      ]),
    ),
  );
  expect(
    structured(
      await mcp.callTool({
        name: "import_evidence_bundle",
        arguments: { path: externalEvidencePath },
      }),
    ).result,
  ).toEqual({ imported: 1, unknowns_added: 0, total: 2 });
  const recordedUnknown = z
    .object({
      result: z.object({ unknown_id: z.string(), revision: z.number() }),
    })
    .parse(
      structured(
        await mcp.callTool({
          name: "record_unknown",
          arguments: {
            question: "Does the alternate branch execute?",
            severity: "medium",
            domain: "control-flow",
            required_authority: "controlled-replay",
            required_confidence: "observed",
            required_environment: null,
            recommended_probes: [],
            relationships: [],
          },
        }),
      ),
    ).result;
  expect(recordedUnknown.revision).toBe(1);
  const listedUnknowns = await mcp.callTool({
    name: "list_unknowns",
    arguments: {},
  });
  expect(listedUnknowns.isError).not.toBe(true);
  expect(
    z
      .object({ result: z.object({ items: z.array(z.unknown()) }) })
      .parse(structured(listedUnknowns)).result.items,
  ).toHaveLength(1);
  return { recordedUnknown };
};

const structured = (result: CallToolResult): Record<string, unknown> => {
  if (result.isError === true) return parseMcpToolError(result);
  if (
    typeof result.structuredContent !== "object" ||
    result.structuredContent === null
  )
    throw new Error("missing structured result");
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
};

/** Direct trusted fixture setup; this is never a successful MCP open receipt. */
export const openOwnedSessionTarget = async (
  harness: SessionMcpHarness,
  path: string,
  snapshotPath?: string,
) => {
  if (path !== harness.first && path !== harness.second)
    throw new Error("Target was not produced by this fixture controller");
  if (snapshotPath === undefined) return harness.session.open(path);
  const selected = relative(dirname(harness.first), snapshotPath);
  if (
    !isAbsolute(snapshotPath) ||
    selected.startsWith("..") ||
    isAbsolute(selected)
  )
    throw new Error("Snapshot is outside this synthetic controller scope");
  const snapshot = await readAnalysisSnapshot(snapshotPath);
  return snapshot.ok
    ? harness.session.open(path, { snapshot: snapshot.value })
    : snapshot;
};
