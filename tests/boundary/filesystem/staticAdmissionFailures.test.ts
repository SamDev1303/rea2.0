import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/analysisErrorCore.js";
import { ArtifactReaderFailure } from "../../../src/artifacts/ArtifactReader.js";
import { translateArtifactFailure } from "../../../src/artifacts/ArtifactFailure.js";
import { DirectoryArtifactReader } from "../../../src/artifacts/DirectoryArtifactReader.js";
import { analyzeInterfaceBuilderBundle } from "../../../src/artifacts/apple/InterfaceBuilderAnalysis.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([false, true])(
  "treats an admission failure as terminal even when wrapped=%s",
  async (wrapped) => {
    const root = await createTestTempDirectory("rea2-terminal-static-");
    await writeFile(join(root, "Main.nib"), "SYNTHETIC_ARCHIVE");
    const denied = new AnalysisCapabilityUnavailableError(
      "rea2-owned-fixture",
      "decode_interface_builder",
      "Synthetic budget exhausted",
    );
    const failure = wrapped
      ? new ArtifactReaderFailure("io", "Synthetic reader wrapper", {
          cause: denied,
        })
      : denied;
    const open = vi
      .spyOn(DirectoryArtifactReader.prototype, "open")
      .mockRejectedValue(failure);
    try {
      await expect(
        analyzeInterfaceBuilderBundle({
          bundlePath: root,
          targetSha256: "0".repeat(64),
        }),
      ).rejects.toBe(failure);
      expect(open).toHaveBeenCalledTimes(1);
      const translated = translateArtifactFailure(
        "decode_interface_builder",
        failure,
      );
      if (wrapped) expect(translated.cause).toBe(failure);
      else expect(translated).toBe(denied);
    } finally {
      open.mockRestore();
    }
  },
);

it("keeps ordinary malformed-archive coverage without reporting successful documents", async () => {
  const root = await createTestTempDirectory("rea2-malformed-static-");
  await writeFile(join(root, "Main.nib"), "SYNTHETIC_INVALID_ARCHIVE");
  const result = await analyzeInterfaceBuilderBundle({
    bundlePath: root,
    targetSha256: "0".repeat(64),
  });
  expect(result.documents).toEqual([]);
  expect(result.limitations).toContainEqual(
    expect.stringContaining("Main.nib"),
  );
});
