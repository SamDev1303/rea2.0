import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DirectoryArtifactReader } from "../../../src/artifacts/DirectoryArtifactReader.js";
import * as javascriptAnalysis from "../../../src/application/javascript/JavaScriptApplicationService.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { serveCli } from "../cli/cliServeHarness.js";

const savedExitCode = process.exitCode;
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = savedExitCode;
});

describe("protected static JavaScript ingestion", () => {
  it.each(["single", "nested"])(
    "rejects %s unfamiliar archive carriers before analysis reads them",
    async (kind) => {
      const root = await createTestTempDirectory("rea2-js-archive-");
      const archive = join(root, "app.asar");
      await writeFile(archive, "SYNTHETIC_PRIVATE_ARCHIVE_SENTINEL");
      const analysis = vi.spyOn(
        javascriptAnalysis,
        "analyzeJavaScriptApplicationValidated",
      );
      const response = await serveCli([
        "analyze-javascript-application",
        kind === "single" ? archive : root,
        "--json",
      ]);
      expect(response.stdout).toContain("capability_unavailable");
      expect(response.stdout).toContain("Unfamiliar archives");
      expect(response.stdout).not.toContain(
        "SYNTHETIC_PRIVATE_ARCHIVE_SENTINEL",
      );
      expect(analysis).not.toHaveBeenCalled();
    },
  );
  it("refuses nested credentials before their content is opened or hashed", async () => {
    const root = await createTestTempDirectory("rea2-js-protected-");
    await writeFile(join(root, "safe.js"), "export const safe = 1;");
    await mkdir(join(root, "secrets"));
    await writeFile(
      join(root, "secrets", "credential.ts"),
      "export const credential = 'SYNTHETIC_CREDENTIAL_SENTINEL';",
    );
    const acquisition = vi.spyOn(DirectoryArtifactReader.prototype, "open");
    const response = await serveCli([
      "analyze-javascript-application",
      root,
      "--json",
    ]);
    const result: unknown = JSON.parse(response.stdout);
    expect(result).toMatchObject({
      error: "JavaScript application analysis failed",
    });
    expect(response.stdout).toContain("Protected artifact");
    expect(response.stdout).not.toContain("SYNTHETIC_CREDENTIAL_SENTINEL");
    expect(
      acquisition.mock.calls.some(([entry]) =>
        entry.path.startsWith("secrets/"),
      ),
    ).toBe(false);
  });

  it("refuses a credential hardlink disguised as an ordinary source filename", async () => {
    const parent = await createTestTempDirectory("rea2-js-hardlink-");
    const protectedRoot = join(parent, "secrets");
    const root = join(parent, "source");
    await mkdir(protectedRoot);
    await mkdir(root);
    const credential = join(protectedRoot, "credential.ts");
    await writeFile(
      credential,
      "export const credential = 'SYNTHETIC_CREDENTIAL_SENTINEL';",
    );
    await link(credential, join(root, "ordinary.ts"));
    const acquisition = vi.spyOn(DirectoryArtifactReader.prototype, "open");
    const response = await serveCli([
      "analyze-javascript-application",
      root,
      "--json",
    ]);
    expect(JSON.parse(response.stdout)).toMatchObject({
      error: "JavaScript application analysis failed",
    });
    expect(response.stdout).toContain("multiple file aliases");
    expect(response.stdout).not.toContain("SYNTHETIC_CREDENTIAL_SENTINEL");
    expect(acquisition).not.toHaveBeenCalled();
  });

  it("preserves ordinary static source analysis without following credential symlinks", async () => {
    const parent = await createTestTempDirectory("rea2-js-symlink-");
    const root = join(parent, "source");
    const protectedRoot = join(parent, "secrets");
    await mkdir(root);
    await mkdir(protectedRoot);
    await writeFile(join(root, "safe.js"), "export const safe = 1;");
    const credential = join(protectedRoot, "credential.ts");
    await writeFile(credential, "SYNTHETIC_CREDENTIAL_SENTINEL");
    await symlink(credential, join(root, "ordinary.ts"));
    const acquisition = vi.spyOn(DirectoryArtifactReader.prototype, "open");
    const response = await serveCli([
      "analyze-javascript-application",
      root,
      "--json",
    ]);
    expect(JSON.parse(response.stdout)).toMatchObject({
      operation: "analyze_javascript_application",
    });
    expect(response.stdout).not.toContain("SYNTHETIC_CREDENTIAL_SENTINEL");
    expect(
      acquisition.mock.calls.some(([entry]) => entry.path === "ordinary.ts"),
    ).toBe(false);
    expect(
      acquisition.mock.calls.some(([entry]) => entry.path === "safe.js"),
    ).toBe(true);
  });
});
