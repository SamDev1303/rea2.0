import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  readlink,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const fixture = async (build = true) => {
  const directory = await createTestTempDirectory("rea2-install-");
  // Spaces and shell metacharacters are literal paths, never evaluated commands.
  const checkout = join(directory, "source ; untouched");
  const home = join(directory, "home ; untouched");
  const binaries = join(directory, "bin");
  await mkdir(checkout);
  await mkdir(binaries);
  await mkdir(join(checkout, "scripts"));
  await copyFile("install.sh", join(checkout, "install.sh"));
  const sentinel = join(directory, "unexpected-effect");
  for (const name of ["npm", "npx", "curl"]) {
    const path = join(binaries, name);
    await writeFile(
      path,
      `#!/bin/sh\nprintf forbidden > '${sentinel}'\nexit 99\n`,
    );
    await chmod(path, 0o755);
  }
  // Even a target launcher with an install-like effect must never run here.
  await writeFile(
    join(checkout, "scripts/rea.mjs"),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(sentinel)}, 'executed');`,
  );
  if (build) {
    await mkdir(join(checkout, "dist"));
    await writeFile(join(checkout, "dist/main.js"), "");
    await writeFile(join(checkout, "dist/cli.js"), "");
  }
  return {
    checkout,
    home,
    sentinel,
    destination: join(home, ".local/bin/rea2"),
    invoke: (args: string[] = []) =>
      spawnSync("/bin/bash", [join(checkout, "install.sh"), ...args], {
        env: {
          ...process.env,
          HOME: home,
          PATH: `${binaries}:${process.env.PATH ?? ""}`,
        },
        encoding: "utf8",
      }),
  };
};

describe("reviewed local checkout registration", () => {
  it("requires a build and does not invoke package managers, network helpers or target code", async () => {
    const value = await fixture(false);
    const result = value.invoke();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("local build is missing");
    await expect(readFile(value.sentinel)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readlink(value.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("dry-run leaves the home directory untouched", async () => {
    const value = await fixture();
    expect(value.invoke(["--dry-run"]).status).toBe(0);
    await expect(readlink(value.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(value.sentinel)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("registers only the exact checkout and is idempotent without executing setup", async () => {
    const value = await fixture();
    expect(value.invoke().status).toBe(0);
    expect(await readlink(value.destination)).toBe(
      join(value.checkout, "scripts/rea.mjs"),
    );
    expect(value.invoke(["--no-setup", "--no-prompt"]).status).toBe(0);
    await expect(readFile(value.sentinel)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it.each(["file", "symlink"])("preserves an unrelated %s", async (kind) => {
    const value = await fixture();
    await mkdir(join(value.home, ".local/bin"), { recursive: true });
    if (kind === "file")
      await writeFile(value.destination, "unrelated command");
    else await symlink("/unrelated/rea2", value.destination);
    const result = value.invoke();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("preserved");
    if (kind === "file")
      expect(await readFile(value.destination, "utf8")).toBe(
        "unrelated command",
      );
    else expect(await readlink(value.destination)).toBe("/unrelated/rea2");
    await expect(readFile(value.sentinel)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("rejects registry version requests before any mutation", async () => {
    const value = await fixture();
    const result = value.invoke(["--version", "latest"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown option: --version");
    await expect(readlink(value.destination)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(value.sentinel)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
