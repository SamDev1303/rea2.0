import { expect } from "vitest";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { machoImage } from "../../../src/artifacts/apple/MachoImage.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  attachNonexecutingMcpFixture,
  type OwnedMcpFixtureRequest,
} from "../../support/investigation/ownedMcpFixture.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { composeBinarySession } from "../../../src/application/binary/BinarySessionComposition.js";
import type { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { AnalysisProviderRegistry } from "../../../src/application/binary/AnalysisProviderRegistry.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import type { JsonValue } from "../../../src/domain/jsonValue.js";
import { ok } from "../../../src/domain/result.js";
import type { GhidraInstallationHost } from "../../../src/ghidra/GhidraInstallation.js";
import type { GhidraOperation } from "../../../src/ghidra/GhidraClient.js";
import { GhidraProvider } from "../../../src/ghidra/GhidraProvider.js";
import type { GhidraProviderClientFactory } from "../../../src/ghidra/GhidraProviderClient.js";
import { GHIDRA_SESSION_CAPABILITIES } from "../../../src/ghidra/GhidraSessionValues.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  ghidraFunctionClassification,
  ghidraFunctionDossier,
  ghidraFunctionIdentity,
  ghidraReferenceEdge,
} from "../../../src/domain/ghidraValues.fixture.js";

const INSTALL = "/opt/ghidra_12.1.4_PUBLIC";

export const connectGhidraMcp = async (
  name: string,
  execute?: ReturnType<GhidraProviderClientFactory>["callTool"],
) => {
  const requests = requestsFor(name);
  const root = await createTestTempDirectory("rea-owned-ghidra-bridge-");
  const target = join(root, "Fixture");
  await writeFile(target, Buffer.from(machoImage({})));
  const calls: GhidraOperation[] = [];
  const factory: GhidraProviderClientFactory = (options) => ({
    start: () =>
      Promise.resolve(
        ok(sessionInfo(options.profileDigest, options.targetSha256)),
      ),
    callTool: (operation, input, options) => {
      calls.push(operation);
      if (execute !== undefined) return execute(operation, input, options);
      return Promise.resolve(ok(resultFor(operation, input)));
    },
    close: () => Promise.resolve(ok(null)),
  });
  const config = parseConfig({ GHIDRA_INSTALL_DIR: INSTALL });
  if (!config.ok) throw config.error;
  const provider = new GhidraProvider(
    config.value,
    silentLogger,
    {},
    installationHost(),
    factory,
  );
  const session = composeBinarySession(
    new AnalysisProviderRegistry([provider]),
  );
  const server = createServer(
    { kind: "session", session },
    { logger: silentLogger, environment: {} },
  );
  const mcp = new Client({ name, version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const close = async () => {
    await Promise.allSettled([mcp.close(), server.close()]);
    await session.close();
  };
  try {
    await server.connect(serverTransport);
    await mcp.connect(clientTransport);
    const denied = await mcp.callTool({
      name: "open_binary",
      arguments: { path: target },
    });
    expect(denied.isError).toBe(true);
    expect(calls).toEqual([]);
    // Only authored inert bytes reach the real provider; its bridge is this fixed in-memory factory.
    const opened = await session.open(target);
    if (!opened.ok) throw opened.error;
    await attachNonexecutingMcpFixture(server, session, requests);
  } catch (cause: unknown) {
    await close();
    throw cause;
  }
  return {
    calls,
    mcp,
    session,
    close,
  };
};

export const sessionEvidence = (session: BinarySession, value: unknown) => {
  const evidence = parseEvidence(value);
  expect(session.evidenceById(evidence.evidence_id)).toEqual(evidence);
  return evidence;
};

const installationHost = (): GhidraInstallationHost => ({
  platform: "linux",
  architecture: "x64",
  readText: () => "application.version=12.1.4\n",
  executable: () => true,
  probeJava: () => ({
    version: "21.0.11",
    major: 21,
    home: "/usr/lib/jvm/jdk-21",
    bits: 64,
    runtime: "jdk",
  }),
});

const sessionInfo = (profileDigest: string, targetSha256: string) => ({
  name: "REA Ghidra bridge" as const,
  run_id: "11111111-1111-4111-8111-111111111111",
  profile_digest: profileDigest,
  provider: { id: "ghidra" as const, version: "12.1.4" },
  read_only: false as const,
  analysis_complete: true,
  analysis_timed_out: false,
  capabilities: [...GHIDRA_SESSION_CAPABILITIES],
  target: {
    name: "fixture",
    language_id: "x86:LE:64:default",
    compiler_spec_id: "gcc",
    image_base: "0x400000",
    default_address_space: "ram",
    sha256: targetSha256,
  },
});

type GhidraResultBuilder = (
  input: Readonly<Record<string, JsonValue>>,
  limit: number,
) => JsonValue;

const resultBuilders = new Map<GhidraOperation, GhidraResultBuilder>([
  ["list_documents", () => ["fixture"]],
  [
    "list_procedures",
    () => [
      {
        address: "0x401000",
        value: "fixture_main",
        procedure: {
          external: false,
          thunk: false,
          thunk_target: null,
        },
      },
    ],
  ],
  [
    "list_strings",
    () => [
      stringItem("0x402000", "inventory fixture"),
      stringItem("0x402020", "external fixture"),
    ],
  ],
  [
    "list_segments",
    () => [
      {
        name: ".text",
        start: "0x401000",
        end: "0x401100",
        readable: true,
        writable: false,
        executable: true,
        permissions: { available: true, source: "ghidra-memory-block" },
        provenance: "ghidra-memory-block",
        address_space: "ram",
        image_base: "0x400000",
        initialized: true,
        overlay: false,
        sections: [],
      },
    ],
  ],
  [
    "list_names",
    () => [
      {
        address: "0x401000",
        value: "fixture_main",
        symbol: {
          primary: true,
          dynamic: false,
          external: false,
          type: "function",
          source: "user_defined",
        },
      },
    ],
  ],
  ["search_procedures", () => []],
  ["search_strings", () => []],
  ["address_name", () => "fixture_main"],
  ["procedure_address", () => "0x401000"],
  [
    "resolve_containing_procedure",
    () => ({
      query_address: "0x401001",
      found: true,
      procedure: ghidraFunctionIdentity(),
    }),
  ],
  ["procedure_assembly", () => "0x401000: CALL 0x401020\n0x401005: RET"],
  ["procedure_callees", () => []],
  ["procedure_callers", () => []],
  [
    "procedure_info",
    () => {
      const identity = ghidraFunctionIdentity();
      return {
        name: "fixture_main",
        entrypoint: "0x401000",
        basicblock_count: 1,
        length: 6,
        signature: "int fixture_main(void)",
        locals: [],
        classification: ghidraFunctionClassification(),
        body: identity.body,
      };
    },
  ],
  ["procedure_pseudo_code", () => "int fixture_main(void) { return 42; }"],
  [
    "read_function_instructions",
    () => ({
      procedure: ghidraFunctionIdentity(),
      instructions: ["0x401000: CALL 0x401020", "0x401005: RET"],
      limitations: ["Ghidra-specific instruction text."],
    }),
  ],
  [
    "procedure_references",
    (input, _limit) => ({
      procedure: ghidraFunctionIdentity(),
      direction: input.direction ?? "outgoing",
      references: [ghidraReferenceEdge()],
    }),
  ],
  ["xrefs", () => ["0x401001"]],
  [
    "analyze_function",
    (input) => ghidraFunctionDossier(input.include_assembly === true),
  ],
]);

const resultFor = (
  operation: GhidraOperation,
  input: Readonly<Record<string, JsonValue>>,
): JsonValue => {
  const builder = resultBuilders.get(operation);
  if (builder === undefined)
    throw new TypeError(`Unexpected Ghidra operation: ${operation}`);
  const value = builder(
    input,
    typeof input.limit === "number" ? input.limit : 100,
  );
  return functionObservationOperations.has(operation)
    ? { value, limitations: [] }
    : value;
};

const functionObservationOperations: ReadonlySet<GhidraOperation> = new Set([
  "analyze_function",
  "procedure_assembly",
  "procedure_info",
  "procedure_pseudo_code",
  "read_function_instructions",
]);

const stringItem = (address: string, value: string): JsonValue => ({
  address,
  value,
  string: {
    encoding: "UTF-8",
    termination: "present_or_not_required",
    byte_length: value.length + 1,
  },
});

/** Complete finite request inventory chosen before any target-facing SDK call. */
const requestsFor = (name: string): readonly OwnedMcpFixtureRequest[] => {
  const table: Record<string, readonly OwnedMcpFixtureRequest[]> = {
    "ghidra-compact-provenance": compactRequests(),
    "ghidra-compact-unknown": compactRequests(),
    "ghidra-failure-diagnostics": [{ name: "list_procedures", arguments: {} }],
    "ghidra-native-api": [
      { name: "inspect_native_api", arguments: { procedure: "fixture_main" } },
    ],
    "ghidra-routing": [
      { name: "batch_decompile", arguments: { addresses: ["fixture_main"] } },
      {
        name: "set_comment",
        arguments: { address: "0x1000", comment: "must not mutate" },
      },
      { name: "binary_session", arguments: {} },
    ],
    "ghidra-parity": [
      { name: "list_procedures", arguments: {} },
      { name: "binary_overview", arguments: {} },
      {
        name: "procedure_pseudo_code",
        arguments: { procedure: "fixture_main" },
      },
      { name: "analyze_function", arguments: { procedure: "fixture_main" } },
    ],
    "ghidra-terminal-call-evidence": [
      ...[
        "procedure_pseudo_code",
        "procedure_assembly",
        "procedure_info",
        "read_function_instructions",
      ].map((name) => ({
        name,
        arguments: { procedure: "0x401000", document: "fixture" },
      })),
      { name: "analyze_function", arguments: { procedure: "0x401000" } },
    ],
    "ghidra-malformed-annotation": [
      {
        name: "annotate_native_function",
        arguments: { procedure: "0x401000", inline_comment: "Finding" },
      },
    ],
    "ghidra-address-naming": [
      {
        name: "set_address_name",
        arguments: { address: "0x1000", name: "fixture_entry" },
      },
      {
        name: "set_addresses_names",
        arguments: {
          names: { "0x1000": "fixture_entry", "0x2000": "g_value" },
        },
      },
    ],
    "ghidra-string-coverage": [
      { name: "list_strings", arguments: {} },
      { name: "search_strings", arguments: { pattern: "projection" } },
      {
        name: "search_strings",
        arguments: { pattern: "projection.*", mode: "regex" },
      },
      { name: "search_procedures", arguments: { pattern: "projection" } },
    ],
    "ghidra-invalid-inventory": [
      ...[0x401000, 0x401004, 0x401008, 0x40100c, 0x401010].map((address) => ({
        name: "read_bytes",
        arguments: { address: `0x${address.toString(16)}`, length: 4 },
      })),
      { name: "address_to_file_offset", arguments: { address: "0x401000" } },
      { name: "list_procedures", arguments: {} },
      { name: "search_strings", arguments: { pattern: "needle" } },
      {
        name: "read_function_instructions",
        arguments: { procedure: "fixture_main" },
      },
      {
        name: "resolve_containing_procedure",
        arguments: { address: "EXTERNAL:0x2" },
      },
    ],
  };
  const requests = table[name];
  if (requests === undefined)
    throw new Error(`Undeclared bridge fixture ${name}`);
  return requests;
};
const compactRequests = (): readonly OwnedMcpFixtureRequest[] => [
  { name: "inspect_native_instruction", arguments: { address: "0x401000" } },
  { name: "resolve_native_call_targets", arguments: { address: "0x401000" } },
];
