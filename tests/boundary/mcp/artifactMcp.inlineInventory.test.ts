import { createHash } from "node:crypto";
import { createOwnedAppleStaticSession } from "../../../src/application/binary/OwnedAppleStaticSession.js";
import {
  attachOwnedFixturePolicy,
  digestOwnedFixtureInput,
  sealOwnedFixturePolicy,
} from "../../../src/application/investigationSafety/OwnedFixturePolicy.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  createOwnedArtifactProducer,
  requireOwnedProducerEvidence,
  assertOwnedFixturePublicDenial,
} from "../../fixtures/ownedArtifactProducer.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { TextReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, it } from "vitest";
import { z } from "zod";
import { keyedArchiveResultSchema } from "../../../src/domain/apple/keyedArchive.js";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import { createServer } from "../../../src/server/createServer.js";

it("inspects an explicitly sealed standalone keyed archive through MCP with original object identities", async () => {
  const directory = await createTestTempDirectory("rea-keyed-mcp-");
  const path = join(directory, "archive.plist");
  await writeFile(
    path,
    await readFile(
      new URL(
        "../../fixtures/golden/keyed-archive/foundation.xml",
        import.meta.url,
      ),
    ),
  );
  const session = createOwnedAppleStaticSession();
  const server = createServer(
    { kind: "session", session },
    { environment: {} },
  );
  const portId = "controller-owned-apple-static-port";
  const requests = [
    { name: "open_binary" as const, arguments: { path } },
    { name: "inspect_keyed_archive" as const, arguments: {} },
    {
      name: "inspect_keyed_archive" as const,
      arguments: { path: "other.plist" },
    },
    { name: "inspect_keyed_archive" as const, arguments: { root: "missing" } },
  ];
  const token = await sealOwnedFixturePolicy(
    {
      roots: [directory],
      files: [
        {
          path,
          sha256: createHash("sha256")
            .update(await readFile(path))
            .digest("hex"),
          role: "dependency",
        },
      ],
      static_inventory: { directories: [] },
      endpoints: [],
      environment: [],
      available_capabilities: ["static"],
      grants: requests.map((request) => ({
        operation: request.name,
        input_digest: digestOwnedFixtureInput(
          toolContract(request.name).inputSchema.parse(request.arguments),
        ),
        capability: "static",
        mode: "owned-static" as const,
        port_id: portId,
      })),
    },
    { owned_static_ports: [{ port_id: portId, reference: session }] },
  );
  attachOwnedFixturePolicy(server, token, session);
  const client = new Client({ name: "keyed-mcp-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await assertOwnedFixturePublicDenial(client, "open_binary", {
      path: join(directory, "ungranted.plist"),
    });
    expect(session.activeTarget()).toBeUndefined();
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path },
    });
    expect(opened.isError).not.toBe(true);
    const called = await client.callTool({
      name: "inspect_keyed_archive",
      arguments: {},
    });
    expect(called.isError, JSON.stringify(called.structuredContent)).not.toBe(
      true,
    );
    const graph = keyedArchiveResultSchema.parse(
      z
        .object({ normalized_result: z.unknown() })
        .parse(called.structuredContent).normalized_result,
    );
    expect(graph.references).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 2, target: 2, status: "resolved" }),
        expect.objectContaining({
          source: 1,
          target: 2,
          status: "resolved",
        }),
      ]),
    );
    const rejected = await client.callTool({
      name: "inspect_keyed_archive",
      arguments: { path: "other.plist" },
    });
    expect(rejected.isError).toBe(true);
    expect(parseMcpToolError(rejected)).toMatchObject({
      error: {
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["path"],
              reason: "invalid_value",
              expected: "archive.plist",
            },
          ],
        },
      },
    });
    const missingRoot = await client.callTool({
      name: "inspect_keyed_archive",
      arguments: { root: "missing" },
    });
    expect(missingRoot.isError).toBe(true);
    expect(parseMcpToolError(missingRoot)).toMatchObject({
      error: {
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["root"],
              reason: "invalid_value",
              message: expect.stringContaining("missing"),
              expected: Object.keys(graph.roots),
            },
          ],
        },
      },
    });
  } finally {
    await client.close();
    await server.close();
    await session.close();
  }
});

it("retains all 520 owned ZIP file occurrences in one direct inspection Evidence while public MCP parsing is denied", async () => {
  const directory = await createTestTempDirectory("rea-artifact-inline-");
  const archive = join(directory, "many.zip");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  const fileCount = 520;
  for (let index = 0; index < fileCount; index += 1)
    await writer.add(
      `files/${String(index)}.txt`,
      new TextReader(`file-${String(index)}`),
    );
  await writeFile(archive, await writer.close());

  const session = createTestBinarySession(new ArtifactProvider({}));
  const producer = createOwnedArtifactProducer(session, [archive]);
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "artifact-inline-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await assertOwnedFixturePublicDenial(client, "open_binary", {
      path: archive,
    });
    expect(session.activeTarget()).toBeUndefined();
    expect((await producer.open(archive)).ok).toBe(true);
    await assertOwnedFixturePublicDenial(client, "inspect_artifact", {});
    const result = requireOwnedProducerEvidence(
      await producer.produce("inspect_artifact"),
    );
    expect(session.evidenceById(result.evidence_id)).toEqual(result);
    const retained = await client.callTool({
      name: "get_evidence_bundle",
      arguments: {
        detail: "summary",
        filters: { evidence_id: result.evidence_id },
      },
    });
    expect(retained.isError).not.toBe(true);
    expect(retained.structuredContent).toMatchObject({
      result: {
        matching_records: 1,
        records: [
          {
            evidence_id: result.evidence_id,
            operation: "inspect_artifact",
            retention: "complete-record",
          },
        ],
      },
    });
    const inspection = z
      .object({
        substeps: z.array(
          z.object({
            evidence: z.object({
              normalized_result: z.object({
                occurrences: z.array(z.object({ logical_path: z.string() })),
              }),
            }),
          }),
        ),
      })
      .parse(
        z.object({ normalized_result: z.unknown() }).parse(result)
          .normalized_result,
      );
    expect(
      inspection.substeps[0]?.evidence.normalized_result.occurrences,
    ).toHaveLength(fileCount + 1);
  } finally {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  }
});
