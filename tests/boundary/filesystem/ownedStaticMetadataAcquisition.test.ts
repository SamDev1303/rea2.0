import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { resolveAppBundleExecutable } from "../../../src/application/AppBundleExecutable.js";
import { traceDylibResolution } from "../../../src/artifacts/apple/DylibResolutionReader.js";
import { DirectoryArtifactReader } from "../../../src/artifacts/DirectoryArtifactReader.js";
import {
  sealOwnedStaticFixtureInventory,
  withOwnedStaticFixtureInventory,
} from "../../../src/application/investigationSafety/OwnedStaticFixtureInventory.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    access: vi.fn(actual.access),
    stat: vi.fn(actual.stat),
    realpath: vi.fn(actual.realpath),
    lstat: vi.fn(actual.lstat),
    open: vi.fn(actual.open),
  };
});
const fixture = async () => {
  const root = await createTestTempDirectory("rea2-static-metadata-");
  const path = join(root, "fixture.plist");
  const bytes = Buffer.from("SYNTHETIC_STATIC_BYTES");
  await fs.writeFile(path, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const token = await sealOwnedStaticFixtureInventory({
    roots: [root],
    directories: [],
    files: [{ path, sha256: digest }],
  });
  vi.clearAllMocks();
  return {
    root,
    path,
    digest,
    token,
    outside: join(root, "..", "outside.app"),
  };
};
it("blocks target existence probes before access outside the sealed inventory", async () => {
  const { token, outside } = await fixture();
  await expect(
    withOwnedStaticFixtureInventory(token, {}, "inspect_keyed_archive", () =>
      parseBinaryTarget(outside),
    ),
  ).rejects.toThrow();
  expect(fs.access).not.toHaveBeenCalled();
  expect(fs.realpath).not.toHaveBeenCalledWith(outside);
});
it("blocks bundle layout existence probes before stat outside the sealed inventory", async () => {
  const { token, outside } = await fixture();
  const result = await withOwnedStaticFixtureInventory(
    token,
    {},
    "decode_interface_builder",
    () => resolveAppBundleExecutable(outside),
  );
  expect(result.ok).toBe(false);
  expect(fs.stat).not.toHaveBeenCalled();
});
it("blocks dyld canonicalization before realpath outside the sealed inventory", async () => {
  const { token, outside, path, digest } = await fixture();
  await expect(
    withOwnedStaticFixtureInventory(token, {}, "trace_dylib_resolution", () =>
      traceDylibResolution({
        rootPath: outside,
        targetPath: path,
        targetSha256: digest,
        enumerateRoots: false,
        parameters: {},
      }),
    ),
  ).rejects.toThrow();
  expect(fs.realpath).not.toHaveBeenCalledWith(outside);
});
it("blocks directory canonicalization before realpath outside the sealed inventory", async () => {
  const { token, outside } = await fixture();
  const reader = new DirectoryArtifactReader(outside);
  try {
    await expect(
      withOwnedStaticFixtureInventory(
        token,
        {},
        "decode_interface_builder",
        async () => {
          for await (const _entry of reader.entries()) {
            /* Admission must fail before enumeration. */
          }
        },
      ),
    ).rejects.toThrow();
    expect(fs.realpath).not.toHaveBeenCalledWith(outside);
  } finally {
    await reader.close();
  }
});
it("rejects an undeclared selected entry before any probe of that entry", async () => {
  const { root, token } = await fixture();
  const undeclared = join(root, "undeclared.plist");
  const reader = new DirectoryArtifactReader(root);
  try {
    await expect(
      withOwnedStaticFixtureInventory(token, {}, "inspect_keyed_archive", () =>
        reader.open({
          path: "undeclared.plist",
          kind: "file",
          declaredSize: 0,
          compressedSize: null,
          executable: false,
          encrypted: false,
          byteOffset: null,
          declaredSha256: null,
          unpacked: false,
          limitations: [],
          adapterKey: undeclared,
        }),
      ),
    ).rejects.toThrow();
    // Root validation is expected; the unlisted leaf must receive no probe.
    expect(fs.realpath).not.toHaveBeenCalledWith(undeclared);
    for (const probe of [fs.access, fs.stat, fs.lstat, fs.open])
      expect(
        vi.mocked(probe).mock.calls.some(([path]) => path === undeclared),
      ).toBe(false);
  } finally {
    await reader.close();
  }
});
