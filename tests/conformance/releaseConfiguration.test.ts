import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { SUPPORTED_NODE_VERSION_RANGE } from "../../src/domain/runtimeVersion.js";

const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(path, "utf8")) as unknown;

const versionedDocumentation = ["docs/installation.md"] as const;

describe("release configuration", () => {
  it("keeps doctor and setup runtime support aligned with package engines", async () => {
    expect(await readJson("package.json")).toMatchObject({
      engines: { node: SUPPORTED_NODE_VERSION_RANGE },
    });
  });

  it("updates every package-version artifact in release PRs", async () => {
    const configuration = await readJson("release-please-config.json");

    expect(configuration).toMatchObject({
      versioning: "always-bump-minor",
      packages: {
        ".": {
          "extra-files": [
            ...versionedDocumentation.map((path) => ({
              type: "generic",
              path,
            })),
            {
              type: "generic",
              path: "src/generatedPackageMetadata.ts",
            },
            {
              type: "json",
              path: "server.json",
              jsonpath: "$.version",
            },
            {
              type: "json",
              path: "server.json",
              jsonpath: "$.packages[0].version",
            },
          ],
        },
      },
    });
  });

  it.each(versionedDocumentation)(
    "marks the versioned package example in %s",
    async (path) => {
      const content = await readFile(path, "utf8");
      const packageJson = (await readJson("package.json")) as {
        version: string;
      };
      const versionBlock =
        /<!-- x-release-please-start-version -->[\s\S]*?<!-- x-release-please-end -->/u.exec(
          content,
        )?.[0];

      expect(versionBlock).toContain(
        `REA 2.0 engine version: ${packageJson.version}`,
      );
    },
  );

  it("keeps the release baseline, lockfile, and changelog aligned with the package version", async () => {
    const packageJson = (await readJson("package.json")) as {
      version: string;
    };
    expect(await readJson(".release-please-manifest.json")).toEqual({
      ".": packageJson.version,
    });
    expect(await readJson("package-lock.json")).toMatchObject({
      version: packageJson.version,
      packages: { "": { version: packageJson.version } },
    });
    const changelog = await readFile("CHANGELOG.md", "utf8");
    expect(/^## \[([^\]]+)\]/mu.exec(changelog)?.[1]).toBe(packageJson.version);
  });

  it("keeps the private local package and unpublished MCP metadata aligned", async () => {
    const packageJson = (await readJson("package.json")) as {
      name: string;
      version: string;
      mcpName: string;
    };
    const serverJson = (await readJson("server.json")) as Record<
      string,
      unknown
    >;
    expect(packageJson).toMatchObject({
      name: "rea2-local",
      mcpName: "io.github.SamDev1303/rea2",
      private: true,
      bin: { rea2: "scripts/rea.mjs" },
      scripts: { prepublishOnly: "node scripts/block-publication.mjs" },
    });
    expect(packageJson).not.toHaveProperty("publishConfig");
    expect(serverJson).toMatchObject({
      name: packageJson.mcpName,
      version: packageJson.version,
      repository: { url: "https://github.com/SamDev1303/rea2.0" },
    });
    expect(serverJson).not.toHaveProperty("packages");
  });
});
