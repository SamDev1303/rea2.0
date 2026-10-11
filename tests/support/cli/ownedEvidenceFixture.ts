import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { onTestFinished } from "vitest";
import { AnalysisProviderRegistry } from "../../../src/application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../src/application/binary/BinarySessionComposition.js";
import { createServer } from "../../../src/server/createServer.js";

/** Real Evidence transport without target acquisition or fixture authority. */
export const connectOwnedEvidenceFixture = async () => {
  const session = composeBinarySession(new AnalysisProviderRegistry([]));
  const server = createServer(
    { kind: "session", session },
    { environment: {} },
  );
  const client = new Client({ name: "owned-static-evidence", version: "1" });
  onTestFinished(async () => {
    await Promise.all([client.close(), server.close()]);
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { session, client };
};
