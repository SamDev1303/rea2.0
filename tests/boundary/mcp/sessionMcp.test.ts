import { attachNonexecutingMcpFixture } from "../../support/investigation/ownedMcpFixture.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { ToolResultDelivery } from "../../../src/server/toolResult.js";
import { registerSessionStatusTool } from "../../../src/server/registerSessionStatusTool.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import {
  createDeferred,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import type {
  AnalysisClient,
  AnalysisProvider,
  CapabilityDescriptor,
  ProviderAvailability,
} from "../../../src/application/AnalysisProvider.js";
import type { AndroidAnalysisPort } from "../../../src/application/android/AndroidAnalysisPort.js";
import { observed as ok } from "../../fixtures/analysisExecution.js";
import { createServer } from "../../../src/server/createServer.js";
import { silentLogger } from "../../../src/logger.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { MAX_JSON_DEPTH } from "../../../src/domain/jsonValue.js";
import { parseAnalysisSnapshot } from "../../../src/domain/analysisSnapshot.js";
import { INVESTIGATION_EXAMPLES } from "../../../src/contracts/investigationExamples.js";
import { ok as resultOk } from "../../../src/domain/result.js";
import {
  createSessionMcpHarness,
  snapshotAndRecordUnknown,
  openOwnedSessionTarget,
} from "./sessionMcpHarness.js";

const SNAPSHOT_PROFILE = createAnalysisProfile(
  { id: "fixture", name: "Fixture analysis provider", version: "1" },
  { fixture: true },
);

const resources: Array<{ close(): Promise<unknown> }> = [];
let directory: string | undefined;
afterEach(async () => {
  await Promise.all(resources.splice(0).map((resource) => resource.close()));
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

describe("MCP snapshot lifecycle ordering", () => {
  it("saves earlier in-flight observations, blocks later calls, and preserves the session on write failure", async () => {
    directory = await createTestTempDirectory("rea-mcp-snapshot-order-");
    const started = createDeferred<void>();
    const release = createDeferred<ReturnType<typeof ok>>();
    const lifecycle = await createSessionMcpHarness(
      directory,
      (closed) => {
        const base = provider(closed);
        return {
          ...base,
          capabilities: () =>
            base.capabilities().map((capability) => ({
              ...capability,
              operation: "address_name",
            })),
          createClient: (target) => ({
            ...client(target.path, closed),
            execute: (name) => {
              if (name === "health") return Promise.resolve(ok(null));
              started.resolve();
              return release.promise;
            },
          }),
        };
      },
      resources,
    );
    const { mcp, first, closed } = lifecycle;
    expect((await openOwnedSessionTarget(lifecycle, first)).ok).toBe(true);
    const observation = mcp.callTool({
      name: "address_name",
      arguments: { address: "0x1000", document: "fixture" },
    });
    await started.promise;
    const snapshotPath = join(directory, "analysis.json");
    const closing = mcp.callTool({
      name: "close_binary",
      arguments: { snapshot_path: snapshotPath },
    });
    const later = mcp.callTool({
      name: "address_name",
      arguments: { address: "0x1001", document: "fixture" },
    });
    expect(
      structured(await mcp.callTool({ name: "binary_session", arguments: {} }))
        .result,
    ).toMatchObject({ open: true });
    expect(closed).toEqual([]);
    release.resolve(ok(first));
    expect((await observation).isError).not.toBe(true);
    expect((await closing).isError).not.toBe(true);
    expect((await later).isError).toBe(true);
    const snapshot = parseAnalysisSnapshot(
      JSON.parse(await readFile(snapshotPath, "utf8")),
    );
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.entries[0]?.execution.result).toBe(first);
    expect(
      snapshot.evidence_bundle.records.some(
        (record) =>
          record.operation === "address_name" &&
          record.normalized_result === first,
      ),
    ).toBe(true);

    expect((await openOwnedSessionTarget(lifecycle, first)).ok).toBe(true);
    const bytes = await readFile(snapshotPath);
    expect(
      (
        await mcp.callTool({
          name: "close_binary",
          arguments: { snapshot_path: snapshotPath },
        })
      ).isError,
    ).toBe(true);
    expect(await readFile(snapshotPath)).toEqual(bytes);
    expect(
      (
        await mcp.callTool({
          name: "address_name",
          arguments: { address: "0x1000", document: "fixture" },
        })
      ).isError,
    ).not.toBe(true);
    expect(
      structured(await mcp.callTool({ name: "binary_session", arguments: {} }))
        .result,
    ).toMatchObject({ open: true });
    expect(
      (
        await mcp.callTool({
          name: "close_binary",
          arguments: { snapshot_path: snapshotPath, overwrite: true },
        })
      ).isError,
    ).not.toBe(true);
  }, 10_000);
});

describe("owned target setup and MCP lifecycle observations", () => {
  it("takes the MCP session snapshot after an inert controller readiness inspection completes", async () => {
    directory = await createTestTempDirectory("rea-mcp-status-readiness-");
    const targetPath = join(directory, "target.hop");
    await writeFile(targetPath, "fixture target");
    const entered = createDeferred<void>();
    const availability = createDeferred<ProviderAvailability>();
    const closed: string[] = [];
    const session = createTestBinarySession(provider(closed));
    const androidAnalysis: AndroidAnalysisPort = {
      inspectAvailability: () => {
        entered.resolve();
        return availability.promise;
      },
      close: () => Promise.resolve(),
      execute: () => Promise.resolve(ok(null)),
    };
    const server = new EvidenceMcpServer(
      { name: "owned-readiness", version: "1" },
      {},
      undefined,
      new ToolResultDelivery(8 * 1024 * 1024),
    );
    registerSessionStatusTool({
      server,
      session,
      contract: toolContract("binary_session"),
      startedAt: new Date().toISOString(),
      availabilityPolicy: () => ({ processCaptureEnabled: false }),
      androidAnalysisAvailability: () => androidAnalysis.inspectAvailability!(),
    });
    const mcp = new Client({ name: "status-readiness", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    resources.push(mcp, server);
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);

    const status = mcp.callTool({ name: "binary_session", arguments: {} });
    await entered.promise;
    expect((await session.open(targetPath)).ok).toBe(true);
    availability.resolve({
      status: "available",
      code: null,
      reason: null,
      diagnostics: { configured: true },
    });

    expect(structured(await status).result).toMatchObject({
      open: true,
      path: targetPath,
    });
  });

  it("reports controller-reopened replaced content at one canonical path through MCP", async () => {
    directory = await createTestTempDirectory("rea-mcp-replaced-target-");
    const targetPath = join(directory, "mutable.hop");
    await writeFile(targetPath, "first");
    const closed: string[] = [];
    const session = createTestBinarySession(provider(closed), {
      resolveAnalysisProfile: () =>
        Promise.resolve(resultOk({ profile: SNAPSHOT_PROFILE })),
    });
    const server = createServer(
      { kind: "session", session },
      { logger: silentLogger },
    );
    const mcp = new Client({ name: "replaced-target", version: "1.0.0" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    resources.push(mcp, server);
    await attachNonexecutingMcpFixture(server, session, [
      { name: "current_document", arguments: {} },
    ]);
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);

    expect(
      (
        await mcp.callTool({
          name: "open_binary",
          arguments: { path: targetPath },
        })
      ).isError,
    ).toBe(true);
    expect(session.activeTarget()).toBeUndefined();
    const firstOpen = await session.open(targetPath);
    expect(firstOpen.ok).toBe(true);
    if (!firstOpen.ok) throw firstOpen.error;
    const first = firstOpen.value;
    expect(
      (await mcp.callTool({ name: "current_document", arguments: {} })).isError,
    ).not.toBe(true);
    await writeFile(targetPath, "second");
    const secondOpen = await session.open(targetPath);
    expect(secondOpen.ok).toBe(true);
    if (!secondOpen.ok) throw secondOpen.error;
    const second = secondOpen.value;

    const canonicalTargetPath = await realpath(targetPath);
    expect(first).toMatchObject({ path: canonicalTargetPath });
    expect(second).toMatchObject({ path: canonicalTargetPath });
    expect(z.object({ sha256: z.string() }).parse(second).sha256).not.toBe(
      z.object({ sha256: z.string() }).parse(first).sha256,
    );
    expect(closed).toEqual([canonicalTargetPath]);
    expect(
      z
        .object({
          result: z.object({ path: z.string(), sha256: z.string() }),
        })
        .parse(
          structured(
            await mcp.callTool({
              name: "binary_session",
              arguments: {},
            }),
          ),
        ).result,
    ).toEqual({
      path: canonicalTargetPath,
      sha256: z.object({ sha256: z.string() }).parse(second).sha256,
    });
  }, 30_000);
});

describe("owned target setup and MCP workflow", () => {
  it("reports no-target, observes controller opening and switching, analyzes, reports status, and closes", async () => {
    directory = await createTestTempDirectory("rea-mcp-session-");
    const lifecycle = await createSessionMcpHarness(
      directory,
      provider,
      resources,
    );
    const { mcp, first, second, closed } = lifecycle;

    expect(
      (await mcp.callTool({ name: "open_binary", arguments: { path: first } }))
        .isError,
    ).toBe(true);
    expect(lifecycle.session.activeTarget()).toBeUndefined();
    expect(
      structured(await mcp.callTool({ name: "binary_session", arguments: {} }))
        .result,
    ).toMatchObject({ open: false });
    expect(
      (await mcp.callTool({ name: "current_document", arguments: {} })).isError,
    ).toBe(true);
    const beforeTools = (await mcp.listTools()).tools;
    const beforeNames = beforeTools.map(({ name }) => name);
    expect(mcp.getInstructions()).toContain(
      "Use the tool that directly answers the question",
    );
    expect(
      beforeTools.find(({ name }) => name === "inspect_artifact")?.description,
    ).toContain("Returns the complete content-addressed artifact graph");
    expect(beforeNames).toContain("open_binary");
    expect(beforeNames).toContain("binary_session");
    expect(beforeNames).toContain("current_document");
    expect(beforeNames).toContain("capture_process_scenario");
    expect((await openOwnedSessionTarget(lifecycle, first)).ok).toBe(true);
    const openedStatus = structured(
      await mcp.callTool({ name: "binary_session", arguments: {} }),
    );
    expect(openedStatus).toMatchObject({
      result: { path: await realpath(first) },
    });
    expect(
      z
        .object({
          result: z.object({
            capabilities: z.array(z.object({ operation: z.string() })),
          }),
        })
        .parse(openedStatus)
        .result.capabilities.map(({ operation }) => operation),
    ).not.toContain("inventory_artifact");
    expect(
      text(await mcp.callTool({ name: "current_document", arguments: {} })),
    ).toContain("first.hop");
    const { recordedUnknown } = await snapshotAndRecordUnknown(
      lifecycle,
      directory,
    );
    const resolved = await mcp.callTool({
      name: "update_unknown",
      arguments: {
        unknown_id: recordedUnknown.unknown_id,
        expected_revision: 1,
        status: "resolved",
        severity: "medium",
        supporting_evidence_ids: [],
        contradicting_evidence_ids: [],
        required_authority: "controlled-replay",
        required_confidence: "observed",
        required_environment: null,
        recommended_probes: [],
        relationships: [],
        resolution: {
          disposition: "out-of-scope",
          rationale: "Operator explicitly excluded this branch from scope.",
          evidence_ids: [],
        },
      },
    });
    expect(resolved.isError).not.toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      structured(
        await mcp.callTool({
          name: "verify_unknown_resolution",
          arguments: { unknown_id: recordedUnknown.unknown_id },
        }),
      ).result,
    ).toMatchObject({ valid: true, truthVerified: false });
    expect((await openOwnedSessionTarget(lifecycle, second)).ok).toBe(true);
    expect(closed.some((path) => path.endsWith("first.hop"))).toBe(true);
    expect(
      text(await mcp.callTool({ name: "binary_session", arguments: {} })),
    ).toContain("second.hop");
    const snapshotPath = join(directory, "analysis.json");
    expect(
      structured(
        await mcp.callTool({
          name: "close_binary",
          arguments: { snapshot_path: snapshotPath },
        }),
      ).result,
    ).toMatchObject({
      path: snapshotPath,
      primitive_entries: 0,
      workflow_entries: 0,
      evidence_records: 0,
    });
    expect(JSON.parse(await readFile(snapshotPath, "utf8"))).toMatchObject({
      evidence_bundle: { records: [], unknowns: [] },
    });
    expect(
      text(await mcp.callTool({ name: "binary_session", arguments: {} })),
    ).toContain('"open":false');
    expect(
      (
        await mcp.callTool({
          name: "open_binary",
          arguments: { path: first, snapshot_path: snapshotPath },
        })
      ).isError,
    ).toBe(true);
    expect(
      structured(await mcp.callTool({ name: "list_unknowns", arguments: {} }))
        .result,
    ).toMatchObject({ items: [] });
    expect(
      (await openOwnedSessionTarget(lifecycle, first, snapshotPath)).ok,
    ).toBe(false);
    expect(
      (await openOwnedSessionTarget(lifecycle, second, snapshotPath)).ok,
    ).toBe(true);
    await mcp.callTool({ name: "close_binary", arguments: {} });
  }, 10_000);
});

describe("session filesystem path boundaries over MCP", () => {
  it("rejects relative snapshot and export paths with an absolute-path error", async () => {
    directory = await createTestTempDirectory("rea-mcp-path-boundary-");
    const lifecycle = await createSessionMcpHarness(
      directory,
      provider,
      resources,
    );
    const { mcp, first } = lifecycle;

    const exported = await mcp.callTool({
      name: "export_evidence_bundle",
      arguments: { path: "relative-bundle.json" },
    });
    expect(exported.isError, JSON.stringify(exported.content)).toBe(true);
    expect(JSON.stringify(exported.content)).toContain("absolute");

    expect((await openOwnedSessionTarget(lifecycle, first)).ok).toBe(true);
    const closed = await mcp.callTool({
      name: "close_binary",
      arguments: { snapshot_path: "relative-analysis.json" },
    });
    expect(closed.isError, JSON.stringify(closed.content)).toBe(true);
    expect(JSON.stringify(closed.content)).toContain("absolute");
    await mcp.callTool({ name: "close_binary", arguments: {} });
  }, 10_000);
});

describe("json depth bounds over MCP", () => {
  it("classifies deeply nested evidence parameters as an input validation error", async () => {
    directory = await createTestTempDirectory("rea-mcp-depth-bound-");
    const { mcp } = await createSessionMcpHarness(
      directory,
      provider,
      resources,
    );
    const input = INVESTIGATION_EXAMPLES.compare_process_captures.input;
    const baseline = await mcp.callTool({
      name: "compare_process_captures",
      arguments: input,
    });
    expect(baseline.isError, JSON.stringify(baseline)).not.toBe(true);
    let value: unknown = 1;
    for (let index = 0; index <= MAX_JSON_DEPTH; index += 1)
      value = { nested: value };
    const result = await mcp.callTool({
      name: "compare_process_captures",
      arguments: {
        left: {
          ...input.left,
          parameters: { attack: value },
        },
        right: input.right,
      },
    });
    const text = JSON.stringify(result.content);
    expect(result.isError, text).toBe(true);
    expect(text).toContain("Input validation");
    expect(text).toContain("maximum nesting depth");
  }, 10_000);
});

const client = (path: string, closed: string[]): AnalysisClient => ({
  execute: (name) =>
    Promise.resolve(
      ok(name === "health" ? null : name === "current_document" ? path : null),
    ),
  close: () => {
    closed.push(path);
    return Promise.resolve(resultOk(null));
  },
});

const provider = (closed: string[]): AnalysisProvider => {
  const identity = {
    id: "fixture",
    name: "Fixture analysis provider",
    version: "1",
  };
  const capability: CapabilityDescriptor = {
    provider: identity,
    operation: "current_document",
    available: true,
    reason: null,
    effects: {
      mutatesArtifact: false,
      launchesProcess: false,
      mayShowUi: false,
      mayAccessNetwork: false,
      mayWriteFilesystem: false,
      changesPermissions: false,
      requiresRoot: false,
    },
    limitations: [],
  };
  return {
    identity: () => identity,
    capabilities: () => [capability],
    createClient: (target) => client(target.path, closed),
  };
};

const text = (result: CallToolResult): string => {
  const content = result.content.find((item) => item.type === "text");
  if (content?.type !== "text") throw new Error("missing text result");
  return content.text;
};

const structured = (result: CallToolResult): Record<string, unknown> => {
  if (result.isError === true) return parseMcpToolError(result);
  if (
    typeof result.structuredContent !== "object" ||
    result.structuredContent === null
  )
    throw new Error(
      `missing structured result: ${JSON.stringify(result.content)}`,
    );
  return z.record(z.string(), z.unknown()).parse(result.structuredContent);
};
