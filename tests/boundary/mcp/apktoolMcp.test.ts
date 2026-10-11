import { retainOwnedServiceEvidence } from "../../fixtures/ownedServiceEvidence.js";
import { assertOwnedFixturePublicDenial } from "../../fixtures/ownedArtifactProducer.js";
import { ApktoolResourceAnalysisService } from "../../../src/application/apktool/ApktoolResourceAnalysisService.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished, vi } from "vitest";

import type { ApktoolResourceAnalysisPort } from "../../../src/application/apktool/ApktoolResourceAnalysisPort.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { assertAdvertisedMcpContracts } from "./mcpContractHarness.js";

const identity = { id: "apktool", name: "Apktool", version: "2.7.0-dirty" };

const clientIdentity = {
  command: "/usr/bin/apktool",
  command_source: "path",
  apktool_version: "2.7.0-dirty",
};

const results: Readonly<Record<string, unknown>> = {
  inspect_apktool_client: { client: clientIdentity },
  decode_android_resources: {
    client: clientIdentity,
    target: {
      path: "/targets/probe.apk",
      bytes: 8524,
      sha256: "a".repeat(64),
    },
    metadata: {
      version_name: "1.2.3",
      version_code: "7",
      min_sdk_version: "24",
      target_sdk_version: "34",
      package_name: "com.rea.apktool.probe",
    },
    manifest:
      '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="com.rea.apktool.probe"/>',
    strings: [{ name: "app_name", value: "ApktoolProbe" }],
    locale: null,
    locales: ["de"],
    decoded_file_count: 5,
    coverage: "complete",
  },
};

it("advertises exact valid Apktool schemas and retains direct inert-provider Evidence through MCP while public execution is denied", async () => {
  const provider: ApktoolResourceAnalysisPort = {
    async inspectAvailability() {
      return { status: "available", code: null, reason: null, diagnostics: {} };
    },
    async close() {},
    async execute(request) {
      return ok(createAnalysisExecution(results[request.operation], identity));
    },
  };
  const executed = vi.spyOn(provider, "execute");
  const service = new ApktoolResourceAnalysisService(provider);
  const session = createTestBinarySession(() => {
    throw new Error("deep provider must not start");
  });
  const server = createServer(
    { kind: "session", session },
    { apktoolAnalysis: provider },
  );
  onTestFinished(() => server.close());
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "apktool-boundary", version: "0.0.0" });
  onTestFinished(() => client.close());
  await client.connect(clientTransport);

  const { tools } = await client.listTools();
  const names = tools.map((tool) => tool.name);
  const operationNames = [
    "inspect_apktool_client",
    "decode_android_resources",
  ] as const;
  for (const name of operationNames) expect(names, name).toContain(name);

  assertAdvertisedMcpContracts(operationNames, tools);

  const input = { path: "/targets/probe.apk" };
  await assertOwnedFixturePublicDenial(
    client,
    "decode_android_resources",
    input,
  );
  expect(executed).not.toHaveBeenCalled();
  const evidence = await retainOwnedServiceEvidence(
    session,
    client,
    await service.execute("decode_android_resources", input),
  );
  expect(evidence.provider.id).toBe("apktool");
  expect(evidence.normalized_result).toMatchObject({
    metadata: { package_name: "com.rea.apktool.probe", version_name: "1.2.3" },
    coverage: "complete",
  });
});
