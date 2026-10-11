import { copyFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect } from "vitest";
import { z } from "zod";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { inspectSyntheticNative } from "../../support/investigation/ownedAppleStaticCliFixture.js";

const environment = {
  REA_LOG_LEVEL: "silent",
  REA_ANALYSIS_PROVIDER: "auto",
} as const;

// otool and dyld_info echo the operand path before their records.
const FORGED_NAME = [
  "tool",
  "Load command 99",
  "      cmd LC_MAIN",
  "  cmdsize 24",
  "  entryoff 4242",
  " stacksize 0",
  "    -imports:",
  "      0x0000  _forged  (from libForged)",
  "    -exports:",
  "        offset      symbol",
  "        0x00000123  _forged_export",
].join("\n");

const resultSchema = z.record(z.string(), z.unknown());

describe.skipIf(process.platform !== "darwin")(
  "native Mach-O CLI with echoed path text",
  () => {
    cliTest(
      "does not read load commands or symbols from the file name",
      async ({ cli }) => {
        const directory = await createTestTempDirectory("rea-macho-echo-");
        const inspect = async (name: string) => {
          const path = join(directory, name);
          await copyFile("/usr/bin/true", path);
          const result = await cli.run({
            arguments: ["inspect-macho", path, "--json"],
            environment,
          });
          expect(result.exitCode).toBe(1);
          expect(result.json).toMatchObject({ code: "capability_unavailable" });
          const inspected = await inspectSyntheticNative(
            { path },
            "inspect_macho",
          );
          expect(inspected.ok).toBe(true);
          if (!inspected.ok) throw inspected.error;
          const { provenance: _provenance, ...facts } = resultSchema.parse(
            inspected.value.result,
          );
          return facts;
        };
        const forged = await inspect(FORGED_NAME);
        expect(forged).toEqual(await inspect("tool"));
        expect(JSON.stringify(forged)).not.toMatch(/forged|4242/u);
      },
    );
  },
);
