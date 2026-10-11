import { writeFile, symlink, link } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { DirectoryArtifactReader } from "../../artifacts/DirectoryArtifactReader.js";
import { swiftSourceAnalysisSchema } from "../../domain/swift/swiftSourceAnalysis.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { analyzeSwiftSource } from "./SwiftSourceService.js";

afterEach(() => vi.restoreAllMocks());
const run = async (input: unknown, signal?: AbortSignal) => {
  const resources = new ArtifactResourceScope();
  try {
    return await analyzeSwiftSource(
      input,
      resources,
      signal === undefined ? {} : { signal },
    );
  } finally {
    await resources.close();
  }
};

it("maps owned inert Swift files with hashes and actual coverage counters", async () => {
  const root = await createTestTempDirectory("rea-swift-source-");
  await writeFile(
    join(root, "Model.swift"),
    "struct Model { func run() { save() } }",
  );
  await writeFile(join(root, "README.txt"), "inert unrelated text");
  const result = await run({ input_path: root });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  const value = swiftSourceAnalysisSchema.parse(result.value.normalized_result);
  expect(value.coverage).toMatchObject({
    source_files: 1,
    non_swift_entries: 1,
    status: "complete-within-lexical-scope",
  });
  expect(value.files[0]!.sha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(value.files[0]!.declarations.map((item) => item.name)).toEqual([
    "Model",
    "run",
  ]);
  expect(value.limitations.join(" ")).toContain("not a Swift compiler");
});

it("rejects an empty or wrong-language directory instead of claiming Swift coverage", async () => {
  const root = await createTestTempDirectory("rea-no-swift-");
  await writeFile(join(root, "script.js"), "const safe = 1;");
  const result = await run({ input_path: root });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unsupported source was admitted");
  expect(result.error).toHaveProperty("_tag", "AnalysisUnsupportedTargetError");
});

it("refuses aliases and protected entries before opening their bytes", async () => {
  const root = await createTestTempDirectory("rea-swift-path-");
  const outside = await createTestTempDirectory("rea-swift-outside-");
  const target = join(outside, "Secret.swift");
  await writeFile(target, "struct Secret {}");
  await symlink(target, join(root, "Alias.swift"));
  const open = vi.spyOn(DirectoryArtifactReader.prototype, "open");
  const result = await run({ input_path: root });
  expect(result.ok).toBe(false);
  expect(open).not.toHaveBeenCalled();
  await writeFile(join(root, ".env"), "OWNED_FAKE_SECRET=never-ingest");
  const protectedResult = await run({ input_path: root });
  expect(protectedResult.ok).toBe(false);
  expect(open).not.toHaveBeenCalled();
});

it("rejects hardlinked source and oversized files before byte acquisition", async () => {
  const root = await createTestTempDirectory("rea-swift-limit-");
  const outside = await createTestTempDirectory("rea-swift-link-");
  const path = join(outside, "Original.swift");
  await writeFile(path, "struct Shared {}");
  await link(path, join(root, "Shared.swift"));
  const open = vi.spyOn(DirectoryArtifactReader.prototype, "open");
  expect((await run({ input_path: root })).ok).toBe(false);
  expect(open).not.toHaveBeenCalled();
  const large = await createTestTempDirectory("rea-swift-large-");
  await writeFile(
    join(large, "Large.swift"),
    Buffer.alloc(1024 * 1024 + 1, 32),
  );
  expect((await run({ input_path: large })).ok).toBe(false);
  expect(open).not.toHaveBeenCalled();
});

it("retains failed reader cleanup for an explicit scope retry", async () => {
  const root = await createTestTempDirectory("rea-swift-cleanup-");
  await writeFile(join(root, "File.swift"), "struct Safe {}");
  const nativeClose = DirectoryArtifactReader.prototype.close;
  const close = vi
    .spyOn(DirectoryArtifactReader.prototype, "close")
    .mockRejectedValueOnce(new Error("owned cleanup failure"))
    .mockImplementation(nativeClose);
  const resources = new ArtifactResourceScope();
  const result = await analyzeSwiftSource({ input_path: root }, resources);
  expect(result.ok).toBe(false);
  expect(close).toHaveBeenCalledTimes(1);
  await resources.close();
  expect(close).toHaveBeenCalledTimes(2);
});

it("keeps the original unsupported-target failure beside failed cleanup and permits retry", async () => {
  const root = await createTestTempDirectory("rea-swift-primary-cleanup-");
  const nativeClose = DirectoryArtifactReader.prototype.close;
  vi.spyOn(DirectoryArtifactReader.prototype, "close")
    .mockRejectedValueOnce(new Error("owned reader close failure"))
    .mockImplementation(nativeClose);
  const resources = new ArtifactResourceScope();
  const result = await analyzeSwiftSource({ input_path: root }, resources);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("failed cleanup was accepted");
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      diagnostics: {
        primary_error: { code: "unsupported_target" },
        cleanup_error: { code: "cleanup_incomplete" },
      },
    },
  });
  await resources.close();
});

it("rejects malformed inputs and pre-cancelled requests", async () => {
  expect((await run({ input_path: "/not-selected", bypass: true })).ok).toBe(
    false,
  );
  expect(
    (await run({ input_path: "/not-selected" }, AbortSignal.abort())).ok,
  ).toBe(false);
});

it("bounds the total mapped symbols across multiple individually bounded files", async () => {
  const root = await createTestTempDirectory("rea-swift-symbol-budget-");
  for (const name of ["First.swift", "Second.swift"]) {
    await writeFile(join(root, name), "f()\n".repeat(60_000));
  }
  const result = await run({ input_path: root });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("unbounded map was accepted");
  expect(result.error).toHaveProperty("reason", "limit");
});
