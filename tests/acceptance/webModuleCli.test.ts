import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
import pino from "pino";
import { registerWebModuleCommands } from "../../src/cli/webModuleCommands.js";
import { serveRegisteredCliFixture } from "../support/cli/registeredCliFixture.js";
import { createWebModuleTraceService } from "../../src/composition/webModules.js";
import { createServer } from "../../src/server/createServer.js";
import { createTestBinarySession } from "../fixtures/binarySession.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";
import { webModuleArtifactsFixture } from "../fixtures/webModuleTrace.js";
import { cliTest } from "../support/cli/cliFixture.js";

cliTest(
  "accepts zero-based numeric source indices and returns the same engine-free CLI/MCP trace",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-module-cli-");
    const artifacts = webModuleArtifactsFixture("import(name)");
    const manifest = {
      ...artifacts.manifest,
      output_directory: root,
      analysis_input: { input_path: join(root, "files"), format: "directory" },
    };
    await mkdir(join(root, "files", "modules"), { recursive: true });
    await writeFile(
      join(root, "files", "modules", "main.js"),
      artifacts.source,
    );
    const manifestPath = join(root, "manifest.json").replaceAll("\\", "/");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const environment = {
      REA_LOG_LEVEL: "silent",
      REA_BROWSER_EXECUTABLE: "relative-missing-browser",
    };
    const deniedCli = await cli.run({
      arguments: ["trace-web-module-imports", manifestPath, "0", "--json"],
      environment,
      timeoutMs: 15000,
    });
    expect(deniedCli.exitCode).toBe(1);
    expect(deniedCli.json).toMatchObject({ code: "capability_unavailable" });
    const cliResponse = await serveRegisteredCliFixture(
      (registered) =>
        registerWebModuleCommands(
          registered,
          pino({ level: "silent" }),
          environment,
        ),
      ["trace-web-module-imports", manifestPath, "0", "--json"],
    );
    expect(cliResponse.exitCode).toBe(0);
    expect(cliResponse.json).toMatchObject({
      normalized_result: {
        engine: null,
        source: { script_index: 0 },
        imports: [
          { resolution: { state: "unknown", reason: "computed-specifier" } },
        ],
      },
    });
    const session = createTestBinarySession(() => {
      throw new Error("no binary acquisition");
    });
    const server = createServer(
      { kind: "session", session },
      {
        webModuleTrace: createWebModuleTraceService(environment),
      },
    );
    const client = new Client({ name: "module-cli-parity", version: "1" });
    onTestFinished(async () => {
      await client.close();
      await server.close();
      await session.close();
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const response = await client.callTool({
      name: "trace_web_module_imports",
      arguments: { manifest_path: manifestPath, script_index: 0 },
    });
    expect(response.isError).toBe(true);
    expect(session.activeTarget()).toBeUndefined();
    const direct = await createWebModuleTraceService(environment).trace({
      manifest_path: manifestPath,
      script_index: 0,
    });
    expect(direct.ok).toBe(true);
    if (!direct.ok) throw direct.error;
    expect(direct.value).toEqual(cliResponse.json);
    expect(session.recordEvidence(direct.value)).toMatchObject({ ok: true });
    const retained = await client.callTool({
      name: "get_evidence_bundle",
      arguments: {},
    });
    expect(retained.isError).not.toBe(true);
    expect(retained.structuredContent).toMatchObject({
      result: { records: expect.arrayContaining([direct.value]) },
    });
  },
);
