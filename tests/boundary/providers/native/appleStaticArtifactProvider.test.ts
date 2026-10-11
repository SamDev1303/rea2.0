import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { build } from "plist";
import { expect, it } from "vitest";

import { AppleStaticArtifactProvider } from "../../../../src/artifacts/AppleStaticArtifactProvider.js";
import { ArtifactProvider } from "../../../../src/artifacts/ArtifactProvider.js";
import { machoImage } from "../../../../src/artifacts/apple/MachoImage.fixture.js";
import type { BinaryTarget } from "../../../../src/domain/binaryTargetTypes.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";

const operations = [
  "decode_interface_builder",
  "inspect_keyed_archive",
  "trace_dylib_resolution",
] as const;

it("declares only the three in-process Apple readers without execution effects", () => {
  const provider = new AppleStaticArtifactProvider();
  expect(provider.capabilities().map(({ operation }) => operation)).toEqual(
    operations,
  );
  for (const { effects } of provider.capabilities())
    expect(Object.values(effects).every((value) => value === false)).toBe(true);
});

it("refuses execution and inventory operations before acquiring a target", async () => {
  const client = new AppleStaticArtifactProvider().createClient({
    path: "/nonexistent-owned-static-target",
    sha256: "a".repeat(64),
    kind: "executable",
    format: "mach-o",
    architecture: "arm64",
    availableArchitectures: ["arm64"],
  });
  for (const operation of [
    "inspect_artifact",
    "inventory_artifact",
    "extract_artifact",
    "inspect_asset_catalog",
    "inspect_plist",
    "inspect_macho",
    "observe_native_ui",
  ] as const) {
    const result = await client.execute(operation, {});
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCapabilityUnavailableError", operation },
    });
  }
  expect(await client.execute("health", {})).toMatchObject({
    ok: true,
    value: { result: null },
  });
  expect(await client.close()).toEqual({ ok: true, value: null });
});

it.each(operations)(
  "preserves real %s parsing and production provider results",
  async (operation) => {
    const root = await createTestTempDirectory("rea-apple-static-provider-");
    const app = join(root, "Fixture.app");
    const executable = join(app, "Contents/MacOS/App");
    const resource = join(app, "Contents/Resources/Owned.nib");
    await mkdir(join(app, "Contents/MacOS"), { recursive: true });
    await mkdir(join(app, "Contents/Resources"));
    const bytes = machoImage({});
    await writeFile(executable, bytes);
    await writeFile(
      join(app, "Contents/Info.plist"),
      "<plist><dict><key>CFBundleExecutable</key><string>App</string></dict></plist>",
    );
    const archive = Buffer.from(
      build({
        $archiver: "NSKeyedArchiver",
        $version: 100000,
        $objects: ["$null", "owned archive value"],
        $top: { root: { CF$UID: 1 } },
      }),
    );
    await writeFile(resource, archive);
    const target: BinaryTarget =
      operation === "inspect_keyed_archive"
        ? {
            path: resource,
            sourcePath: resource,
            sha256: createHash("sha256").update(archive).digest("hex"),
            kind: "artifact",
            format: "plist",
          }
        : {
            path: executable,
            sourcePath: app,
            bundleInfoPlist: join(app, "Contents/Info.plist"),
            sha256: createHash("sha256").update(bytes).digest("hex"),
            kind: "executable",
            format: "mach-o",
            architecture: "arm64",
            availableArchitectures: ["arm64"],
          };
    const staticClient = new AppleStaticArtifactProvider().createClient(target);
    const productionClient = new ArtifactProvider({}).createClient(target);
    try {
      const result = await staticClient.execute(operation, {});
      if (!result.ok) throw result.error;
      expect(result).toEqual(await productionClient.execute(operation, {}));
      expect(result.value.provider.id).toBe("rea-artifact-graph");
      if (operation === "inspect_keyed_archive")
        expect(result.value.result).toMatchObject({
          roots: { root: { CF$UID: 1 } },
          objects: expect.arrayContaining([
            expect.objectContaining({ value: "owned archive value" }),
          ]),
        });
      else if (operation === "decode_interface_builder")
        expect(result.value.result).toMatchObject({
          documents: [{ relative_path: "Contents/Resources/Owned.nib" }],
        });
      else
        expect(result.value.result).toMatchObject({
          roots: [{ image: "Contents/MacOS/App", architecture: "arm64" }],
          images: [{ path: "Contents/MacOS/App", sha256: target.sha256 }],
        });
    } finally {
      expect(await staticClient.close()).toEqual({ ok: true, value: null });
      expect(await productionClient.close()).toEqual({ ok: true, value: null });
    }
  },
);
