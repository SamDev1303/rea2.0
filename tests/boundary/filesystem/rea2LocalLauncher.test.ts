import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const root = resolve(import.meta.dirname, "../../..");

const fixture = async () => {
  const directory = await createTestTempDirectory("rea2-local-");
  await mkdir(join(directory, "scripts"));
  await mkdir(join(directory, "bin"));
  await copyFile(join(root, "install.sh"), join(directory, "install.sh"));
  await copyFile(
    join(root, "scripts/rea.mjs"),
    join(directory, "scripts/rea.mjs"),
  );
  await writeFile(
    join(directory, "package.json"),
    '{"name":"rea2-local","version":"6.4.0","type":"module","private":true}',
  );
  const marker = join(directory, "unexpected-network-or-install");
  for (const name of ["npm", "npx", "curl"]) {
    const path = join(directory, "bin", name);
    await writeFile(
      path,
      `#!/bin/sh\nprintf forbidden > '${marker}'\nexit 99\n`,
    );
    await chmod(path, 0o755);
  }
  return {
    directory,
    marker,
    env: {
      PATH: `${join(directory, "bin")}:${process.env.PATH ?? ""}`,
      HOME: join(directory, "home"),
    },
  };
};

describe("local launchers fail closed", () => {
  it("fails a missing build without running a package manager or network helper", async () => {
    const { directory, marker, env } = await fixture();
    const result = spawnSync(
      process.execPath,
      [join(directory, "scripts/rea.mjs"), "mcp"],
      { env, encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("local compiled runtime is missing");
    expect(result.stderr).toContain("no upstream fallback");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("requires an existing build and preserves unrelated commands", async () => {
    const { directory, marker, env } = await fixture();
    const missing = spawnSync("/bin/bash", [join(directory, "install.sh")], {
      env,
      encoding: "utf8",
    });
    expect(missing.status).toBe(1);
    await mkdir(join(directory, "dist"));
    await writeFile(join(directory, "dist/main.js"), "");
    await writeFile(join(directory, "dist/cli.js"), "");
    await mkdir(join(env.HOME, ".local/bin"), { recursive: true });
    const existing = join(env.HOME, ".local/bin/rea2");
    await writeFile(existing, "unrelated command");
    const result = spawnSync("/bin/bash", [join(directory, "install.sh")], {
      env,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("preserved");
    expect(await readFile(existing, "utf8")).toBe("unrelated command");
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
