import { createHash } from "node:crypto";
import fs, { open } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { traceDylibResolution } from "../../../src/artifacts/apple/DylibResolutionReader.js";
import { machoImage } from "../../../src/artifacts/apple/MachoImage.fixture.js";
import { translateArtifactFailure } from "../../../src/artifacts/ArtifactFailure.js";
import { OwnedStaticFixtureCleanupFailure } from "../../../src/application/investigationSafety/OwnedStaticFixtureResources.js";
import {
  ownedStaticFixturePendingCleanupCount,
  retryOwnedStaticFixtureCleanup,
  sealOwnedStaticFixtureInventory,
  withOwnedStaticFixtureInventory,
} from "../../../src/application/investigationSafety/OwnedStaticFixtureInventory.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
const emergency: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of emergency.splice(0)) await close();
});
it.each([
  ["target", false, 1, false],
  ["target", true, 1, false],
  ["target admission", true, 1, false],
  ["dylib magic", false, 1, true],
  ["dylib image", false, 1, false],
  ["dylib hash", false, 2, false],
  ["dylib hash", true, 2, false],
  ["dylib cancelled", true, 1, false],
] as const)(
  "%s retains failed parser cleanup (primary=%s)",
  async (route, failRead, failedOpen, enumerateRoots) => {
    const root = await createTestTempDirectory("rea-parser-cleanup-");
    const path = join(root, "Image");
    const bytes = Buffer.from(machoImage({}));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await fs.writeFile(path, bytes);
    const token = await sealOwnedStaticFixtureInventory({
      roots: [root],
      directories: [],
      files: [{ path, sha256 }],
    });
    const controller = new AbortController();
    const primary = new Error("synthetic parser primary");
    const closing = new Error("synthetic parser cleanup");
    let parserOpens = 0,
      closes = 0;
    vi.mocked(open).mockImplementation(async (selected, flags, mode) => {
      const handle = await fs.open(selected, flags, mode);
      if (selected === path && ++parserOpens === failedOpen) {
        const actualClose = handle.close.bind(handle);
        emergency.push(async () => {
          if (handle.fd >= 0) await actualClose();
        });
        vi.spyOn(handle, "close").mockImplementation(async () => {
          if (++closes === 1) throw closing;
          await actualClose();
        });
        if (route === "target admission")
          vi.spyOn(handle, "stat").mockRejectedValue(primary);
        else if (route === "dylib cancelled")
          vi.spyOn(handle, "read").mockImplementation(async () => {
            controller.abort(primary);
            throw primary;
          });
        else if (failRead) vi.spyOn(handle, "read").mockRejectedValue(primary);
      }
      return handle;
    });
    const operation = route.startsWith("target")
      ? "open_binary"
      : "trace_dylib_resolution";
    const result = await withOwnedStaticFixtureInventory(
      token,
      {},
      operation,
      () =>
        route.startsWith("target")
          ? parseBinaryTarget(path)
          : traceDylibResolution({
              rootPath: root,
              targetPath: path,
              targetSha256: sha256,
              enumerateRoots,
              parameters: {},
              signal: controller.signal,
            }),
    ).catch((cause: unknown) => cause);
    expect(result).toBeInstanceOf(OwnedStaticFixtureCleanupFailure);
    const failure = result as OwnedStaticFixtureCleanupFailure;
    expect(failure.cause).toBe(failRead ? primary : closing);
    expect(failure.cleanupCause).toBe(closing);
    expect(failure.retainedOwnedFile).toBeDefined();
    expect(ownedStaticFixturePendingCleanupCount(token)).toBe(1);
    expect(translateArtifactFailure("trace_dylib_resolution", failure)).toBe(
      failure,
    );
    const one = retryOwnedStaticFixtureCleanup(token),
      two = retryOwnedStaticFixtureCleanup(token);
    expect(one).toBe(two);
    await Promise.all([one, two]);
    expect(closes).toBe(2);
    expect(ownedStaticFixturePendingCleanupCount(token)).toBe(0);
    expect(failure.cleanupIncomplete).toBe(true);
  },
);
