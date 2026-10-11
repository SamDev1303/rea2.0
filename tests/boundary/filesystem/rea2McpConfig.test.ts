import { spawnSync } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const fixture = async () => {
  const checkout = await createTestTempDirectory("rea2-mcp-config-");
  await mkdir(join(checkout, "scripts"));
  await copyFile(
    "scripts/print-mcp-config.mjs",
    join(checkout, "scripts/print-mcp-config.mjs"),
  );
  return { checkout, script: join(checkout, "scripts/print-mcp-config.mjs") };
};

describe("local MCP configuration", () => {
  it("fails clearly without a local build", async () => {
    const { script } = await fixture();
    const result = spawnSync(process.execPath, [script, "synthetic-target"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No upstream fallback");
  });
  it("pins the current Node executable and exact local checkout launcher", async () => {
    const { checkout, script } = await fixture();
    await mkdir(join(checkout, "dist"));
    await writeFile(join(checkout, "dist/main.js"), "");
    const target = join(checkout, "synthetic ; literal target");
    const result = spawnSync(
      process.execPath,
      [script, target, "--kind", "database"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout) as unknown).toEqual({
      mcpServers: {
        rea2: {
          command: process.execPath,
          args: [join(checkout, "scripts/rea.mjs"), "mcp"],
          env: { HOPPER_TARGET_PATH: target, HOPPER_TARGET_KIND: "database" },
        },
      },
    });
    expect(result.stdout).not.toContain("npx");
    expect(result.stdout).not.toContain("rea-agents");
  });
});
