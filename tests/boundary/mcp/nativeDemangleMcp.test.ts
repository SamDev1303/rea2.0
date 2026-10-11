import {
  retainOwnedServiceEvidence,
  observeOwnedNativeFixture,
} from "../../fixtures/ownedServiceEvidence.js";
import { assertOwnedFixturePublicDenial } from "../../fixtures/ownedArtifactProducer.js";
import { NativeMacOSProvider } from "../../../src/native/NativeMacOSProvider.js";
import { XcrunCommandRunner } from "../../../src/native/CommandRunner.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, vi } from "vitest";
import { z } from "zod";

import { createServer } from "../../../src/server/createServer.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { mcpTest } from "../../support/mcp/mcpFixture.js";

const demangledSchema = z.object({
  normalized_result: z.object({
    symbols: z.array(
      z.object({ input: z.string(), output: z.string(), status: z.string() }),
    ),
  }),
});

describe.skipIf(process.platform !== "darwin")(
  "installed Swift demangling on an authored fixture with retained MCP Evidence and public execution denied",
  () => {
    mcpTest(
      "passes option-like symbols to swift-demangle as symbols",
      async ({ mcp, onTestFinished }) => {
        const target = join(
          await createTestTempDirectory("rea-demangle-mcp-"),
          "tool",
        );
        const header = Buffer.alloc(32);
        header.writeUInt32LE(0xfeedfacf, 0);
        header.writeUInt32LE(0x0100000c, 4);
        header.writeUInt32LE(2, 12);
        await writeFile(target, header);
        // Only the installed xcrun/swift-demangle utility runs, with a clean
        // environment; this authored Mach-O target is never executed.
        const runner = new XcrunCommandRunner({});
        const run = vi.spyOn(runner, "run");
        const session = createTestBinarySession(
          new NativeMacOSProvider({}, runner),
        );
        onTestFinished(async () => {
          await session.close();
        });
        const client = await mcp.connect(
          createServer({ kind: "session", session }),
        );
        await assertOwnedFixturePublicDenial(client, "open_binary", {
          path: target,
        });
        expect(session.activeTarget()).toBeUndefined();
        expect((await session.open(target)).ok).toBe(true);
        const input = {
          symbols: ["-help", "--simplified", "$s4main3FooV", "carriage\r"],
        };
        await assertOwnedFixturePublicDenial(client, "demangle_swift", input);
        expect(run).not.toHaveBeenCalled();
        const called = await retainOwnedServiceEvidence(
          session,
          client,
          await observeOwnedNativeFixture(
            session,
            target,
            "demangle_swift",
            input,
          ),
        );

        expect(demangledSchema.parse(called).normalized_result.symbols).toEqual(
          [
            { input: "-help", output: "-help", status: "unchanged" },
            {
              input: "--simplified",
              output: "--simplified",
              status: "unchanged",
            },
            { input: "$s4main3FooV", output: "main.Foo", status: "demangled" },
            { input: "carriage\r", output: "carriage\r", status: "unchanged" },
          ],
        );

        const spanning = await client.callTool({
          name: "demangle_swift",
          arguments: { symbols: ["$s4main\n3FooV"] },
        });
        expect(spanning.isError).toBe(true);
        expect(JSON.stringify(spanning.content)).toContain(
          "Each Swift symbol must be one line.",
        );
        const invalidNativeString = await client.callTool({
          name: "demangle_swift",
          arguments: { symbols: ["$s4main\0FooV"] },
        });
        expect(invalidNativeString.isError).toBe(true);
        expect(JSON.stringify(invalidNativeString.content)).toContain(
          "Swift symbols cannot contain NUL.",
        );
      },
    );
  },
);
