import { link, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { expect, it } from "vitest";
import { LocalWebScriptArtifacts } from "../../../src/browser/assets/LocalWebScriptArtifacts.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { webModuleArtifactsFixture } from "../../fixtures/webModuleTrace.js";

const materialize = async () => {
  const root = join(
    await createTestTempDirectory("rea-script-manifest-path-"),
    "export with spaces",
  );
  const artifact = webModuleArtifactsFixture();
  await mkdir(join(root, "files", "modules"), { recursive: true });
  await mkdir(join(root, "nested"));
  const sourcePath = join(root, "files", "modules", "main.js");
  const manifestPath = join(root, "manifest.json");
  await writeFile(sourcePath, artifact.source);
  await writeFile(manifestPath, JSON.stringify(artifact.manifest));
  return { root, artifact, sourcePath, manifestPath };
};

it.each(["protected-descendant", "hardlink"] as const)(
  "rejects a manifest-derived %s even when its digest matches",
  async (kind) => {
    const fixture = await materialize();
    const manifest = structuredClone(fixture.artifact.manifest);
    const selected = manifest.scripts[0];
    if (selected === undefined || selected.content.state !== "exported")
      throw new Error("Expected exported fixture source");
    if (kind === "protected-descendant") {
      await mkdir(join(fixture.root, "files", "secrets"));
      await writeFile(
        join(fixture.root, "files", "secrets", "fixture.js"),
        fixture.artifact.source,
      );
      selected.content.relative_path = "secrets/fixture.js";
    } else {
      await link(fixture.sourcePath, join(fixture.root, "files", "alias.js"));
      selected.content.relative_path = "alias.js";
    }
    await writeFile(fixture.manifestPath, JSON.stringify(manifest));
    const response = await new LocalWebScriptArtifacts(
      "trace_web_source_location",
    ).load({
      manifest_path: fixture.manifestPath,
      script_index: 0,
    });
    if (response.ok)
      throw new Error("Expected protected derived source rejection");
    expect(response.error).toMatchObject({ reason: "path" });
  },
);

it("reads equivalent local manifest spellings without changing reported identity", async () => {
  const fixture = await materialize();
  const paths = new Set([
    fixture.manifestPath,
    fixture.manifestPath.replaceAll("\\", "/"),
    `${fixture.root}${sep}nested${sep}..${sep}manifest.json`,
  ]);
  const fromWorkingDirectory = relative(process.cwd(), fixture.manifestPath);
  // A target on another Windows drive has no relative path from this cwd.
  if (!isAbsolute(fromWorkingDirectory))
    paths.add(`.${sep}${fromWorkingDirectory}`);
  for (const operation of [
    "trace_web_module_imports",
    "trace_web_source_location",
  ] as const) {
    for (const manifestPath of paths) {
      const response = await new LocalWebScriptArtifacts(operation).load({
        manifest_path: manifestPath,
        script_index: 0,
      });
      if (!response.ok) throw response.error;
      expect(response.value.source).toBe(fixture.artifact.source);
      expect(response.value.sourceFile).toEqual({
        ...fixture.artifact.sourceFile,
        path: fixture.sourcePath,
      });
      expect(response.value.manifestFile.path).toBe(manifestPath);
      expect(response.value.manifest.output_directory).toBe(
        fixture.artifact.manifest.output_directory,
      );
      expect(response.value.manifest.scripts[0]?.url).toBe(
        fixture.artifact.manifest.scripts[0]?.url,
      );
    }
  }
});

it("still rejects changed source bytes after normalizing the selected manifest path", async () => {
  const fixture = await materialize();
  await writeFile(fixture.sourcePath, "tampered source");
  const response = await new LocalWebScriptArtifacts(
    "trace_web_module_imports",
  ).load({
    manifest_path: `${fixture.root}/nested/../manifest.json`.replaceAll(
      "\\",
      "/",
    ),
    script_index: 0,
  });
  if (response.ok) throw new Error("Expected source integrity mismatch");
  expect(projectAnalysisError(response.error).code).toBe(
    "artifact_integrity_mismatch",
  );
});
