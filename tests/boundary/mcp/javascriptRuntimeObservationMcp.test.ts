import { retainOwnedServiceEvidence } from "../../fixtures/ownedServiceEvidence.js";
import { assertOwnedFixturePublicDenial } from "../../fixtures/ownedArtifactProducer.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { ok as resultOk } from "../../../src/domain/result.js";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, test } from "vitest";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import {
  observeJavaScriptRuntime,
  listJavaScriptRuntimeTargets,
} from "../../../src/application/javascript/JavaScriptRuntimeObservationService.js";
import { V8InspectorProvider } from "../../../src/inspector/V8InspectorProvider.js";
import {
  javascriptRuntimeObservationSchema,
  javascriptRuntimeTargetListSchema,
  observeJavaScriptRuntimeInputSchema,
} from "../../../src/domain/javascript/javascriptRuntimeObservation.js";
import { createServer } from "../../../src/server/createServer.js";
import { observed } from "../../fixtures/analysisExecution.js";
import { startFakeV8Inspector } from "../../fixtures/inspector/fakeV8Inspector.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("JavaScript runtime observation MCP tools", () => {
  const resources: Array<{ close(): Promise<unknown> }> = [];
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(resources.splice(0).map((item) => item.close()));
    await Promise.all(
      temporary
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  test(
    "accepts long caller windows and complete observation metadata",
    verifyLongRuntimeMetadata,
  );

  test("lists and observes an owned Inspector fixture directly with retained MCP Evidence and public runtime denied", async () => {
    const root = await createTestTempDirectory("rea-v8-mcp-");
    temporary.push(root);
    const { entry, inspector, client, session, provider } =
      await createObservationClient(root, resources);

    const listedInput = {
      inspector_endpoint: inspector.endpoint,
    };
    const listedPriorCommands = inspector.commands.length;
    await assertOwnedFixturePublicDenial(
      client,
      "list_javascript_runtime_targets",
      listedInput,
    );
    expect(inspector.commands).toHaveLength(listedPriorCommands);
    const listed = await retainOwnedServiceEvidence(
      session,
      client,
      await listJavaScriptRuntimeTargets(
        provider,
        toolContract("list_javascript_runtime_targets").inputSchema.parse(
          listedInput,
        ),
      ),
    );
    expect(listed).toMatchObject({
      normalized_result: {
        targets: [{ target_id: inspector.targetId }],
      },
    });
    const observedRuntimeInput = {
      inspector_endpoint: inspector.endpoint,
      target_id: inspector.targetId,
      runtime_kind: "node",
      observation_ms: 10,
    };
    const observedRuntimePriorCommands = inspector.commands.length;
    await assertOwnedFixturePublicDenial(
      client,
      "observe_javascript_runtime",
      observedRuntimeInput,
    );
    expect(inspector.commands).toHaveLength(observedRuntimePriorCommands);
    const observedRuntime = await retainOwnedServiceEvidence(
      session,
      client,
      await observeJavaScriptRuntime(
        provider,
        toolContract("observe_javascript_runtime").inputSchema.parse(
          observedRuntimeInput,
        ),
      ),
    );
    expect(observedRuntime).toMatchObject({
      normalized_result: {
        target: {
          target_id: inspector.targetId,
          runtime_kind: "node",
          runtime_kind_authority: "caller-declared-unverified",
        },
        scripts: {
          items: [
            expect.objectContaining({
              location: { kind: "file", file_path: entry },
            }),
          ],
        },
      },
    });
    const evidenceId = evidenceIdFrom(observedRuntime);
    expect(observedRuntime).toMatchObject({
      evidence_id: evidenceId,
      operation: "observe_javascript_runtime",
      parameters: expect.any(Object),
    });
    expect(new Set(inspector.commands.map(({ method }) => method))).toEqual(
      new Set(["Runtime.enable", "Debugger.enable"]),
    );
    const direct = await observeDirectly(inspector);
    expect(direct.ok).toBe(true);
    if (direct.ok) expect(evidenceId).toBe(direct.value.evidence_id);
  });
});

const createObservationClient = async (
  root: string,
  resources: Array<{ close(): Promise<unknown> }>,
) => {
  const entry = join(root, "entry.js");
  await writeFile(entry, "export const value = 1;\n");
  const inspector = await startFakeV8Inspector({
    targetUrl: pathToFileURL(entry).href,
  });
  resources.push(inspector);
  const session = createTestBinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(resultOk(null)),
  }));
  const provider = new V8InspectorProvider();
  const server = createServer(
    { kind: "session", session },
    {
      javascriptRuntimeObservation: provider,
      availabilityPolicy: () => ({
        processCaptureEnabled: false,
      }),
    },
  );
  const client = new Client({ name: "v8-mcp-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server, session);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { entry, inspector, client, session, provider };
};

const observeDirectly = (
  inspector: Awaited<ReturnType<typeof startFakeV8Inspector>>,
) =>
  observeJavaScriptRuntime(
    new V8InspectorProvider(),
    observeJavaScriptRuntimeInputSchema.parse({
      inspector_endpoint: inspector.endpoint,
      target_id: inspector.targetId,
      runtime_kind: "node",
      observation_ms: 10,
    }),
  );

const evidenceIdFrom = (value: unknown): string => {
  if (typeof value !== "object" || value === null)
    throw new TypeError("Missing structured result");
  const evidenceId = Reflect.get(value, "evidence_id");
  if (typeof evidenceId !== "string")
    throw new TypeError("Missing Evidence ID");
  return evidenceId;
};

function verifyLongRuntimeMetadata(): void {
  const repeated = (count: number): string[] =>
    Array.from({ length: count }, (_, index) => `item-${index}`);
  const scope = {
    inspector_endpoint: "http://127.0.0.1:9222",
  };
  expect(
    observeJavaScriptRuntimeInputSchema.parse({
      ...scope,
      target_id: "target",
      observation_ms: 2_147_483_648,
    }).observation_ms,
  ).toBe(2_147_483_648);
  expect(
    javascriptRuntimeTargetListSchema.parse({
      runtime: {
        product: "Node.js",
        protocol_version: "1.0",
        v8_version: null,
      },
      targets: [],
      excluded: {
        unsupported_location: 0,
        unconnectable: 0,
      },
      limitations: repeated(101),
    }).limitations,
  ).toHaveLength(101);

  const unknowns = repeated(101);
  const limitations = repeated(101);
  expect(
    javascriptRuntimeObservationSchema.parse({
      runtime: {
        product: "Node.js",
        protocol_version: "1.0",
        v8_version: null,
      },
      target: {
        target_id: "target",
        protocol_type: "node",
        attached: false,
        location: { kind: "file", file_path: "/tmp/rea-runtime/main.js" },
        runtime_kind: "node",
        runtime_kind_authority: "caller-declared-unverified",
      },
      capture: {
        observation_ms: 10_001,
        events_observed: 0,
        events_retained: 0,
        events_dropped: 0,
        metadata_bytes_retained: 0,
        truncated: false,
        truncation_reasons: repeated(21),
      },
      scripts: {
        items: [],
        observed_total: 0,
        excluded: {
          unsupported_location: 0,
          invalid_protocol_value: 0,
        },
      },
      execution_contexts: [],
      directly_observed: repeated(21),
      unavailable_without_instrumentation: repeated(21),
      unknowns,
      limitations,
    }),
  ).toMatchObject({ unknowns, limitations });
}
