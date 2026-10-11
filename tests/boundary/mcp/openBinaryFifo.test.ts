import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { ArtifactProvider } from "../../../src/artifacts/ArtifactProvider.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { readWithoutFifoWriter } from "../../fixtures/fifoInput.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";

it.skipIf(process.platform === "win32")(
  "rejects an open_binary FIFO without waiting for a writer",
  async () => {
    const root = await createTestTempDirectory("rea-open-binary-fifo-");
    const fifoPath = join(root, "input.bin");
    await promisify(execFile)("mkfifo", [fifoPath]);
    const session = createTestBinarySession(new ArtifactProvider({}));
    const server = createServer({ kind: "session", session });
    const client = new Client({ name: "fifo-target-test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      const outcome = await readWithoutFifoWriter(fifoPath, () =>
        client.callTool({ name: "open_binary", arguments: { path: fifoPath } }),
      );
      expect(outcome.state).toBe("completed");
      if (outcome.state !== "completed")
        throw new Error("MCP open_binary waited for a FIFO writer");
      expect(outcome.result.isError).toBe(true);
      expect(parseMcpToolError(outcome.result)).toMatchObject({
        error: {
          code: "capability_unavailable",
          message: expect.stringContaining(
            "No verified disposable analysis runner",
          ),
        },
      });
      // The owned synthetic resolver must still reject a FIFO without a writer.
      const parsed = await readWithoutFifoWriter(fifoPath, () =>
        parseBinaryTarget(fifoPath),
      );
      expect(parsed.state).toBe("completed");
      if (parsed.state !== "completed" || parsed.result.ok)
        throw new Error("Owned FIFO resolver did not reject promptly");
      expect(projectAnalysisError(parsed.result.error)).toMatchObject({
        code: "target_unavailable",
        message: expect.stringContaining("not a regular file"),
      });
      expect(session.status()).toMatchObject({ open: false });
    } finally {
      await Promise.allSettled([
        client.close(),
        server.close(),
        session.close(),
      ]);
    }
  },
);
