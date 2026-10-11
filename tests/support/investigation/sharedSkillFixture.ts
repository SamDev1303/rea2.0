import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Seed a registry-owned skill before setup; the setup command must preserve it. */
export const seedSharedSkillFixture = async (
  home: string,
  mirrorDirectory: string,
): Promise<{ path: string; content: string }> => {
  const canonical = join(home, "Sync/skills/rea2");
  const content =
    '---\nname: rea2\nmetadata:\n  version: "1.0.0"\n---\nRegistry-owned synthetic fixture.\n';
  await mkdir(canonical, { recursive: true });
  await mkdir(mirrorDirectory, { recursive: true });
  await writeFile(join(canonical, "SKILL.md"), content);
  await symlink(canonical, join(mirrorDirectory, "rea2"), "dir");
  return { path: join(canonical, "SKILL.md"), content };
};
