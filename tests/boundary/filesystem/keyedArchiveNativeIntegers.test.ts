import { copyFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { inspectBundleKeyedArchive } from "../../../src/artifacts/apple/KeyedArchiveReader.js";
import { keyedArchiveResultSchema } from "../../../src/domain/apple/keyedArchive.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  keyedArchiveIntegerFormats,
  keyedArchiveIntegerCases,
  keyedArchiveIntegerFixture,
  expectKeyedArchiveIntegerCase,
} from "../../fixtures/keyedArchiveIntegers.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { runOwnedKeyedArchiveCli } from "../../support/investigation/ownedAppleStaticCliFixture.js";

const cases = keyedArchiveIntegerFormats.flatMap((format) =>
  keyedArchiveIntegerCases.map((selectedCase) => ({ format, selectedCase })),
);
// Selected by the existing required native keyed-archive verifier, not Linux skips.
describe.skipIf(process.platform !== "darwin")(
  "Foundation archive integer precision",
  () => {
    it.each(cases)(
      "filesystem preserves $format $selectedCase numeric meaning",
      async ({ format, selectedCase }) => {
        const fixture = await keyedArchiveIntegerFixture(format);
        const result = await inspectBundleKeyedArchive({
          bundlePath: fixture.root,
          targetSha256: fixture.digest,
          parameters: { path: fixture.selected.filename, limit: 100 },
        });
        expectKeyedArchiveIntegerCase(
          result,
          selectedCase,
          fixture.selected,
          fixture.digest,
        );
      },
    );
    cliTest.for(cases)(
      "built CLI preserves $format $selectedCase numeric meaning",
      async ({ format, selectedCase }, { processes }) => {
        const fixture = await keyedArchiveIntegerFixture(format);
        // Keep compiler caches and oracle files outside the sealed reader carrier.
        const root = await createTestTempDirectory("rea-keyed-cli-carrier-");
        const path = join(root, fixture.selected.filename);
        await copyFile(fixture.archivePath, path);
        const output = await runOwnedKeyedArchiveCli(processes, {
          root,
          path,
          digest: fixture.digest,
        });
        expect(output.exitCode).toBe(0);
        const result = keyedArchiveResultSchema.parse(
          parseEvidence(output.json).normalized_result,
        );
        expectKeyedArchiveIntegerCase(
          result,
          selectedCase,
          fixture.selected,
          fixture.digest,
        );
      },
    );
  },
);
