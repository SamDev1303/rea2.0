import { retainOwnedServiceEvidence } from "../../fixtures/ownedServiceEvidence.js";
import {
  assertOwnedFixturePublicDenial,
  projectOwnedProducerError,
} from "../../fixtures/ownedArtifactProducer.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import type { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { analyzeJavaScriptApplication as analyzeScopedJavaScript } from "../../../src/application/javascript/JavaScriptApplicationService.js";
import {
  listElectronTargets,
  inspectElectronPage,
} from "../../../src/application/javascript/ElectronObservationService.js";
import { captureElectronScenario } from "../../../src/application/javascript/ElectronActiveObservationService.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { ok as resultOk } from "../../../src/domain/result.js";
import { rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createStrippedAsarAddon } from "../../fixtures/strippedAsarAddon.js";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import type { ElectronActiveObservationPort } from "../../../src/application/javascript/ElectronActiveObservationPort.js";
import { analyzeJavaScriptApplication } from "../../support/javascriptApplicationScope.js";
import { CdpElectronProvider } from "../../../src/browser/CdpElectronProvider.js";
import { createServer } from "../../../src/server/createServer.js";
import * as electronTools from "../../../src/server/registerElectronTools.js";
import { observed } from "../../fixtures/analysisExecution.js";
import {
  startFakeCdpBrowser,
  type FakeCdpBrowser,
} from "../../fixtures/fakeCdpBrowser.js";
import { writeElectronBoundaryFixture } from "../../fixtures/electronBoundaryApplication.js";
import { createElectronActiveObservationFixtureResult } from "../../../src/domain/javascript/electronActiveObservation.fixture.js";
import { AsarArtifactReader } from "../../../src/artifacts/AsarArtifactReader.js";

const browsers: FakeCdpBrowser[] = [];
const resources: Array<{ close(): Promise<unknown> }> = [];
const temporary: string[] = [];

it("retains owned ASAR inventory cleanup through actual server shutdown retries while MCP archives stay denied", async () => {
  const { archive } = await createStrippedAsarAddon();
  const session = createTestBinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(resultOk(null)),
  }));
  let factoryScope: ArtifactResourceScope | undefined;
  const registerElectronTools = electronTools.registerElectronTools;
  const registration = vi
    .spyOn(electronTools, "registerElectronTools")
    .mockImplementation((server, options) => {
      factoryScope = options.artifactResources;
      registerElectronTools(server, options);
    });
  const server = createServer({ kind: "session", session });
  expect(registration).toHaveBeenCalledTimes(1);
  registration.mockRestore();
  if (factoryScope === undefined)
    throw new Error("The production server did not supply its artifact scope");
  const client = new Client({ name: "javascript-cleanup-owner", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const originalClose = AsarArtifactReader.prototype.close;
  const owners = new Set<AsarArtifactReader>();
  let blocked = true;
  const close = vi
    .spyOn(AsarArtifactReader.prototype, "close")
    .mockImplementation(function (this: AsarArtifactReader) {
      owners.add(this);
      if (blocked) return Promise.reject(new Error("snapshot cleanup blocked"));
      return originalClose.call(this);
    });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const input = {
      input_path: archive,
      integrity_policy: "record-and-continue",
    };
    await assertOwnedFixturePublicDenial(
      client,
      "analyze_javascript_application",
      input,
    );
    expect(owners.size).toBe(0);
    const response = projectOwnedProducerError(
      await analyzeScopedJavaScript(input, factoryScope),
    );
    expect(response).toMatchObject({
      error: {
        code: "cleanup_incomplete",
        details: {
          resources: [expect.stringContaining(archive)],
          partial_observation: { kind: "artifact-inventory" },
        },
      },
    });
    expect(owners.size).toBe(1);
    await expect(server.close()).rejects.toThrow();
    blocked = false;
    await server.close();
    expect(owners.size).toBe(1);
    expect(close.mock.calls.length).toBeGreaterThanOrEqual(3);
  } finally {
    blocked = false;
    await Promise.all([client.close(), server.close(), session.close()]);
    close.mockRestore();
  }
});

afterEach(async () => {
  await Promise.all(resources.splice(0).map(async (item) => item.close()));
  await Promise.all(browsers.splice(0).map(async (browser) => browser.close()));
  await Promise.all(
    temporary
      .splice(0)
      .map(async (path) => rm(path, { recursive: true, force: true })),
  );
});

it("lets direct owned JavaScript analysis continue only with recorded untrusted ASAR bytes while public archives stay denied", async () => {
  const { archive, addon } = await createStrippedAsarAddon();
  const session = createTestBinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(resultOk(null)),
  }));
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "asar-integrity-policy", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server, session);
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  await assertOwnedFixturePublicDenial(
    client,
    "analyze_javascript_application",
    { input_path: archive },
  );
  const rejected = projectOwnedProducerError(
    await analyzeJavaScriptApplication({ input_path: archive }),
  );
  expect(rejected).toMatchObject({
    error: {
      code: "artifact_integrity_mismatch",
      remediation: {
        action: expect.stringContaining("integrity_policy=record-and-continue"),
      },
    },
  });

  const continuedInput = {
    input_path: archive,
    integrity_policy: "record-and-continue",
  };
  await assertOwnedFixturePublicDenial(
    client,
    "analyze_javascript_application",
    continuedInput,
  );
  const continued = await retainOwnedServiceEvidence(
    session,
    client,
    await analyzeJavaScriptApplication(continuedInput),
  );
  expect(continued).toMatchObject({
    parameters: { integrity_policy: "record-and-continue" },
    normalized_result: {
      integrity_contradictions: [
        { logical_path: addon, trust: "observed-untrusted" },
      ],
      graph: { coverage: { status: "partial" } },
    },
  });
});

it("retains direct owned-loopback Electron discovery and inspection Evidence while public observation is denied", async () => {
  const root = await createTestTempDirectory("rea-electron-mcp-");
  temporary.push(root);
  await writeOwnedElectronRuntimeFixture(root);
  const browser = await startFakeCdpBrowser({
    electronFileUrl: pathToFileURL(join(root, "index.html")).href,
    commandEvents: ({ method }) =>
      method === "Debugger.enable"
        ? [
            {
              method: "Debugger.scriptParsed",
              sessionId: "session-1",
              params: {
                scriptId: "partial-script",
                url: pathToFileURL(join(root, "app.js")).href,
                executionContextId: 1,
              },
            },
          ]
        : undefined,
  });
  browsers.push(browser);
  const session = createTestBinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(resultOk(null)),
  }));
  const provider = new CdpElectronProvider();
  const server = createServer(
    { kind: "session", session },
    {
      electronObservation: provider,
      availabilityPolicy: () => ({
        processCaptureEnabled: false,
      }),
    },
  );
  const client = new Client({ name: "electron-mcp-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server, session);
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const listedInput = {
    cdp_endpoint: browser.endpoint,
  };
  const listedPriorCommands = browser.commands.length;
  await assertOwnedFixturePublicDenial(
    client,
    "list_electron_targets",
    listedInput,
  );
  expect(browser.commands).toHaveLength(listedPriorCommands);
  const listed = await retainOwnedServiceEvidence(
    session,
    client,
    await listElectronTargets(
      provider,
      toolContract("list_electron_targets").inputSchema.parse(listedInput),
    ),
  );
  expect(listed).toMatchObject({
    normalized_result: {
      targets: [{ target_id: "electron-page" }],
    },
  });
  const inspectedInput = {
    cdp_endpoint: browser.endpoint,
    target_id: "electron-page",
    observation_ms: 0,
    include_script_sources: true,
  };
  const inspectedPriorCommands = browser.commands.length;
  await assertOwnedFixturePublicDenial(
    client,
    "inspect_electron_page",
    inspectedInput,
  );
  expect(browser.commands).toHaveLength(inspectedPriorCommands);
  const inspected = await retainOwnedServiceEvidence(
    session,
    client,
    await inspectElectronPage(
      provider,
      toolContract("inspect_electron_page").inputSchema.parse(inspectedInput),
    ),
  );
  const analyzed = await client.callTool({
    name: "analyze_javascript_application",
    arguments: { input_path: root },
  });
  expect(analyzed.isError).not.toBe(true);
  expect(analyzed.structuredContent).toMatchObject({
    normalized_result: {
      graph: { nodes: expect.any(Array), edges: expect.any(Array) },
    },
  });
  const analysisText = analyzed.content.find(({ type }) => type === "text");
  expect(analysisText).toBeDefined();
  if (analysisText?.type !== "text")
    throw new TypeError("Missing JavaScript analysis text projection");
  expect(analysisText.text).toContain('"nodes":[');
  const reconciled = await client.callTool({
    name: "reconcile_javascript_runtime",
    arguments: {
      static_layers: [
        {
          role: "application",
          analysis: evidenceFor(analyzed.structuredContent),
        },
      ],
      runtime_observations: [evidenceFor(inspected)],
    },
  });
  expect(reconciled.isError).not.toBe(true);
  expect(reconciled.structuredContent).toMatchObject({
    normalized_result: {
      summary: { runtime_scripts: 1, matched: expect.any(Number) },
      source_map_authority: { used_for_primary_matching: false },
    },
  });
  expect(inspected).toMatchObject({
    normalized_result: {
      target: { file_path: expect.stringMatching(/\/index\.html$/u) },
      scripts: {
        items: [
          expect.objectContaining({
            frame_id: "frame-main",
            file_path: expect.stringMatching(/\/app\.js$/u),
            cdp_hash: null,
            length: null,
            is_module: null,
          }),
        ],
      },
      workers: [
        expect.objectContaining({
          target_id: "electron-worker",
          opener_target_id: "electron-page",
          file_path: expect.stringMatching(/\/worker\.js$/u),
        }),
      ],
    },
  });
}, 20_000);

it("runs direct recording-provider Electron scenarios with selected paths and inferred working directory while public execution stays denied", async () => {
  const root = await createTestTempDirectory("rea-electron-active-mcp-");
  temporary.push(root);
  const applicationPath = join(root, "main.js");
  await writeFile(applicationPath, "module.exports = {};\n");
  const aliasedRoot = join(root, "..", `${root.split("/").at(-1)}-alias`);
  await symlink(root, aliasedRoot, "dir");
  temporary.push(aliasedRoot);
  const workingDirectory = await createTestTempDirectory(
    "rea-electron-working-directory-",
  );
  temporary.push(workingDirectory);
  const capturedInputs: unknown[] = [];
  const activeResult =
    createElectronActiveObservationFixtureResult(applicationPath);
  const provider: ElectronActiveObservationPort = {
    identity: () => ({
      id: "test-electron-active",
      name: "Test Electron active provider",
      version: "1",
    }),
    capture: async (input) => {
      capturedInputs.push(input);
      return { ok: true, value: activeResult };
    },
  };
  const session = createTestBinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(resultOk(null)),
  }));
  const server = createServer(
    { kind: "session", session },
    {
      electronActiveObservation: provider,
      availabilityPolicy: () => ({
        processCaptureEnabled: false,
      }),
    },
  );
  const client = new Client({ name: "electron-active-mcp-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server, session);
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const capturedInput = {
    executable_path: process.execPath,
    application_path: join(aliasedRoot, "main.js"),
    application_root: workingDirectory,
    args: ["--token", "super-secret"],
    actions: [{ step_id: "submit", kind: "click", selector: "#submit-secret" }],
  };
  const capturedPriorCount = capturedInputs.length;
  await assertOwnedFixturePublicDenial(
    client,
    "capture_electron_scenario",
    capturedInput,
  );
  expect(capturedInputs).toHaveLength(capturedPriorCount);
  const captured = await retainOwnedServiceEvidence(
    session,
    client,
    await captureElectronScenario(
      provider,
      toolContract("capture_electron_scenario").inputSchema.parse(
        capturedInput,
      ),
    ),
  );
  expect(captured).toMatchObject({
    normalized_result: {
      application: { process_ownership: "provider-owned" },
      ipc: { events: [{ channel: "readiness:echo" }] },
      coverage: {
        status: "partial_attach",
        pre_capture_activity: "unavailable",
      },
    },
  });
  expect(capturedInputs).toHaveLength(1);
  expect(capturedInputs[0]).toMatchObject({
    application_path: applicationPath,
    application_root: workingDirectory,
  });
  const inferredRootInput = {
    executable_path: process.execPath,
    application_path: applicationPath,
    actions: [],
  };
  const inferredRootPriorCount = capturedInputs.length;
  await assertOwnedFixturePublicDenial(
    client,
    "capture_electron_scenario",
    inferredRootInput,
  );
  expect(capturedInputs).toHaveLength(inferredRootPriorCount);
  const inferredRoot = await retainOwnedServiceEvidence(
    session,
    client,
    await captureElectronScenario(
      provider,
      toolContract("capture_electron_scenario").inputSchema.parse(
        inferredRootInput,
      ),
    ),
  );
  expect(inferredRoot.operation).toBe("capture_electron_scenario");
  expect(capturedInputs[1]).toMatchObject({
    application_path: applicationPath,
    application_root: root,
  });
  expect(JSON.stringify(captured)).toContain("submit-secret");
  expect(JSON.stringify(captured)).toContain("super-secret");
  expect(captured).toMatchObject({
    predicate_type: "rea.electron-active-scenario",
    operation: "capture_electron_scenario",
    parameters: {
      args: ["--token", "super-secret"],
      actions: [
        {
          step_id: "submit",
          kind: "click",
          selector: "#submit-secret",
          window_index: 0,
        },
      ],
    },
  });
}, 20_000);

it("exposes the target-free static JavaScript application workflow", async () => {
  const root = await createTestTempDirectory("rea-electron-static-mcp-");
  temporary.push(root);
  await writeElectronBoundaryFixture(root);
  const session = createTestBinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(resultOk(null)),
  }));
  const server = createServer(
    { kind: "session", session },
    {
      availabilityPolicy: () => ({
        processCaptureEnabled: false,
      }),
    },
  );
  const client = new Client({
    name: "electron-static-mcp-test",
    version: "1",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server, session);
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  const progress: number[] = [];
  const analyzed = await client.callTool(
    {
      name: "analyze_javascript_application",
      arguments: { input_path: root },
    },
    { onprogress: (update) => progress.push(update.progress) },
  );

  expect(analyzed.isError).not.toBe(true);
  expect(progress[0]).toBe(0);
  expect(progress.at(-1)).toBe(1);
  const projected = z
    .object({
      evidence_id: z.string(),
      normalized_result: z.object({
        input_path: z.string(),
        summary: z.object({
          browser_windows: z.number(),
          context_bridge_apis: z.number(),
          ipc: z.object({ paired_renderer_transmissions: z.number() }),
        }),
        graph: z.object({
          graph_id: z.string(),
          nodes: z.array(z.unknown()),
          edges: z.array(z.unknown()),
        }),
        semantic_graph: z.object({
          graph_id: z.string(),
          nodes: z.array(z.unknown()),
          relations: z.array(z.unknown()),
        }),
      }),
      operation: z.literal("analyze_javascript_application"),
      parameters: z.object({ format: z.string() }),
    })
    .parse(analyzed.structuredContent);
  expect(projected.normalized_result).toMatchObject({
    input_path: expect.stringMatching(/rea-electron-static-mcp-/u),
    summary: {
      browser_windows: 3,
      context_bridge_apis: 2,
      ipc: { paired_renderer_transmissions: 4 },
    },
  });
  expect(projected.normalized_result.graph.nodes.length).toBeGreaterThan(0);
  expect(
    projected.normalized_result.semantic_graph.nodes.length,
  ).toBeGreaterThan(0);
  expect(projected.operation).toBe("analyze_javascript_application");
  const direct = await analyzeJavaScriptApplication({ input_path: root });
  if (!direct.ok) throw direct.error;
  expect(projected.evidence_id).toBe(direct.value.evidence_id);
});

const evidenceFor = (value: unknown) => {
  return parseEvidence(value);
};

const writeOwnedElectronRuntimeFixture = async (
  root: string,
): Promise<void> => {
  await writeFile(join(root, "index.html"), "<script src='app.js'></script>");
  await writeFile(
    join(root, "app.js"),
    "export const observed = 'source-secret';",
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "runtime-fixture", renderer: "index.html" }),
  );
  await writeFile(join(root, "worker.js"), "self.onmessage = () => {};\n");
};
