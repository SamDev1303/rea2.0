import { expect } from "vitest";
import { z } from "zod";

import { createOwnedAppleStaticSession } from "../../../src/composition/OwnedAppleStaticSession.js";
import {
  attachOwnedFixturePolicy,
  digestOwnedFixtureInput,
  sealOwnedFixturePolicy,
} from "../../../src/application/investigationSafety/OwnedFixturePolicy.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { keyedArchiveResultSchema } from "../../../src/domain/apple/keyedArchive.js";
import { createServer } from "../../../src/server/createServer.js";
import {
  archiveNumberMetadataCases,
  expectKeyedArchiveNumberMetadata,
  keyedArchiveNumberMetadataFixture,
} from "../../fixtures/keyedArchiveNumberMetadata.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

mcpTest.for(archiveNumberMetadataCases)(
  "MCP preserves numeric meaning for $name",
  async (item, { mcp, onTestFinished }) => {
    const fixture = await keyedArchiveNumberMetadataFixture(item);
    const session = createOwnedAppleStaticSession();
    onTestFinished(async () => {
      await session.close();
    });
    const server = createServer({ kind: "session", session });
    const portId = "controller-owned-apple-static-port";
    const capability = "owned-apple-static-fixture";
    const requests = [
      { name: "open_binary" as const, arguments: { path: fixture.path } },
      { name: "inspect_keyed_archive" as const, arguments: {} },
    ];
    const token = await sealOwnedFixturePolicy(
      {
        roots: [fixture.root],
        files: [
          { path: fixture.path, sha256: fixture.digest, role: "dependency" },
        ],
        static_inventory: { directories: [] },
        endpoints: [],
        environment: [],
        available_capabilities: [capability],
        grants: requests.map((request) => ({
          operation: request.name,
          input_digest: digestOwnedFixtureInput(
            toolContract(request.name).inputSchema.parse(request.arguments),
          ),
          capability,
          mode: "owned-static",
          port_id: portId,
        })),
      },
      { owned_static_ports: [{ port_id: portId, reference: session }] },
    );
    attachOwnedFixturePolicy(server, token, session);
    const client = await mcp.connect(server);
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path: fixture.path },
    });
    expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
    const result = await client.callTool({
      name: "inspect_keyed_archive",
      arguments: {},
    });
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    expectKeyedArchiveNumberMetadata(
      z
        .object({ normalized_result: keyedArchiveResultSchema })
        .parse(result.structuredContent).normalized_result,
      item,
      fixture.digest,
    );
  },
);
