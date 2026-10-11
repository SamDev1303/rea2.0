import {
  createOwnedArtifactProducer,
  requireOwnedProducerEvidence,
  projectOwnedProducerError,
  assertOwnedFixturePublicDenial,
} from "../../fixtures/ownedArtifactProducer.js";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { createStrippedAsarAddon } from "../../fixtures/strippedAsarAddon.js";

const openArchive = async (archive: string) => {
  const session = createTestBinarySession(new ArtifactProvider({}));
  const producer = createOwnedArtifactProducer(session, [archive]);
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "asar-unpacked-extraction", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  onTestFinished(async () => {
    await Promise.allSettled([client.close(), server.close(), session.close()]);
  });
  await assertOwnedFixturePublicDenial(client, "open_binary", {
    path: archive,
  });
  expect(session.activeTarget()).toBeUndefined();
  expect((await producer.open(archive)).ok).toBe(true);
  return { client, producer };
};

it("directly extracts an owned rewritten unpacked companion only when its mismatch is recorded; public MCP stays denied", async () => {
  const { archive, addon, stripped } = await createStrippedAsarAddon();
  const { client, producer } = await openArchive(archive);

  await assertOwnedFixturePublicDenial(client, "extract_artifact", {});
  const strict = await producer.produce("extract_artifact");
  expect(projectOwnedProducerError(strict).error).toMatchObject({
    code: "artifact_integrity_mismatch",
    message: expect.stringContaining(
      `Declared ASAR integrity for unpacked entry ${addon} contradicts its companion file; packaging tools commonly sign or strip unpacked native binaries after writing the archive. If expected, rerun extract_artifact with integrity_policy=record-and-continue`,
    ),
    details: { logical_path: addon, unpacked: true },
  });

  await assertOwnedFixturePublicDenial(client, "extract_artifact", {
    integrity_policy: "record-and-continue",
  });
  const continued = requireOwnedProducerEvidence(
    await producer.produce("extract_artifact", {
      integrity_policy: "record-and-continue",
    }),
  );
  const evidence = parseEvidence(continued);
  expect(evidence.parameters).toMatchObject({
    integrity_policy: "record-and-continue",
  });
  const result = z
    .object({
      output_root: z.string(),
      integrity_contradictions: z.array(
        z.object({ logical_path: z.string(), trust: z.string() }),
      ),
      limitations: z.array(z.string()),
    })
    .parse(evidence.normalized_result);
  onTestFinished(() =>
    rm(result.output_root, { recursive: true, force: true }),
  );
  expect(await readFile(join(result.output_root, addon))).toEqual(stripped);
  expect(result.integrity_contradictions).toEqual([
    { logical_path: addon, trust: "observed-untrusted" },
  ]);
  expect(result.limitations).toContain(
    "1 extracted file(s) contradict declared integrity metadata; their bytes are observed-untrusted.",
  );
});

it("names a missing owned unpacked companion in direct producer diagnostics while MCP stays denied", async () => {
  const { archive, addon } = await createStrippedAsarAddon();
  await rm(join(`${archive}.unpacked`, addon));
  const { client, producer } = await openArchive(archive);

  await assertOwnedFixturePublicDenial(client, "extract_artifact", {});
  const extracted = await producer.produce("extract_artifact");
  expect(projectOwnedProducerError(extracted).error).toMatchObject({
    code: "artifact_operation_failed",
    category: "unavailable",
    message: `ASAR unpacked companion bytes are unavailable for ${addon}. Select the archive in place with its .unpacked directory beside it, then retry.`,
    details: { logical_path: addon, unpacked: true },
  });
});
