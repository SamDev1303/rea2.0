import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { readSharedSkillIdentity } from "../../../src/application/SetupSkill.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const manifest =
  '---\nname: rea2\nmetadata:\n  version: "1.0.0"\n---\nRegistry-owned fixture.\n';
const registry = async () => {
  const home = await createTestTempDirectory("rea2-shared-");
  const root = join(home, "Sync/skills/rea2");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "SKILL.md"), manifest);
  return { home, root };
};

describe("shared skill discovery", () => {
  it("verifies registry provenance and selected canonical mirrors without writing", async () => {
    const { home, root } = await registry();
    const destination = join(home, ".agents/skills/rea2");
    await mkdir(dirname(destination), { recursive: true });
    await symlink(root, destination, "dir");
    expect(await readSharedSkillIdentity(home, ["codex"], {})).toEqual({
      source: "shared-registry",
      canonical: true,
      version: "1.0.0",
      toolCount: null,
    });
    expect(await readFile(join(root, "SKILL.md"), "utf8")).toBe(manifest);
  });
  it("keeps an unrelated skill copy stale instead of adopting it", async () => {
    const { home } = await registry();
    const destination = join(home, ".agents/skills/rea2");
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "SKILL.md"), manifest);
    expect(await readSharedSkillIdentity(home, ["codex"], {})).toMatchObject({
      canonical: false,
    });
  });
  it("does not fall back to a retained upstream skill", async () => {
    const home = await createTestTempDirectory("rea2-shared-missing-");
    const old = join(home, ".agents/skills/reverse-engineer-anything");
    await mkdir(old, { recursive: true });
    await writeFile(join(old, "SKILL.md"), manifest);
    expect(await readSharedSkillIdentity(home, ["codex"], {})).toBeUndefined();
  });
  it("rejects oversized registry manifests before unbounded ingestion", async () => {
    const { home, root } = await registry();
    await writeFile(join(root, "SKILL.md"), manifest + "x".repeat(65_536));
    expect(await readSharedSkillIdentity(home, [], {})).toBeUndefined();
  });
  it("rejects wrong identity and rejects a symlinked canonical manifest", async () => {
    const { home, root } = await registry();
    await writeFile(
      join(root, "SKILL.md"),
      manifest.replace("name: rea2", "name: unrelated"),
    );
    expect(await readSharedSkillIdentity(home, [], {})).toMatchObject({
      canonical: false,
    });
    await writeFile(join(root, "OTHER.md"), manifest);
    await rm(join(root, "SKILL.md"));
    await symlink(join(root, "OTHER.md"), join(root, "SKILL.md"));
    expect(await readSharedSkillIdentity(home, [], {})).toBeUndefined();
  });
});
