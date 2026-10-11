import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs, { open } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  ownedStaticFixturePendingCleanupCount,
  sealOwnedStaticFixtureInventory,
  withOwnedStaticFixtureInventory,
} from "../../../src/application/investigationSafety/OwnedStaticFixtureInventory.js";
import { traceDylibResolution } from "../../../src/artifacts/apple/DylibResolutionReader.js";
import { ArtifactReaderFailure } from "../../../src/artifacts/ArtifactReader.js";
import { machoImage } from "../../../src/artifacts/apple/MachoImage.fixture.js";
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/analysisErrorCore.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});
afterEach(() => vi.restoreAllMocks());

const fixture = async () => {
  const root = await createTestTempDirectory("rea-dylib-nonblocking-");
  const path = join(root, "Image");
  const bytes = Buffer.from(machoImage({}));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  await fs.writeFile(path, bytes);
  const token = await sealOwnedStaticFixtureInventory({
    roots: [root],
    directories: [],
    files: [{ path, sha256 }],
  });
  const traceUnscoped = (enumerateRoots: boolean) =>
    traceDylibResolution({
      rootPath: root,
      targetPath: path,
      targetSha256: sha256,
      enumerateRoots,
      parameters: {},
    });
  const trace = (enumerateRoots: boolean) =>
    withOwnedStaticFixtureInventory(token, {}, "trace_dylib_resolution", () =>
      traceUnscoped(enumerateRoots),
    );
  return { path, token, trace, traceUnscoped };
};

it("opens dyld magic, image and digest descriptors with nonblocking no-follow flags", async () => {
  const { path, trace } = await fixture();
  const selectedFlags: number[] = [];
  vi.mocked(open).mockImplementation(async (selected, flags, mode) => {
    if (selected === path) {
      expect(typeof flags).toBe("number");
      selectedFlags.push(flags as number);
      // Check before opening: no FIFO or other hostile leaf is opened by this test.
      expect((flags as number) & constants.O_NONBLOCK).toBe(
        constants.O_NONBLOCK,
      );
      expect((flags as number) & constants.O_NOFOLLOW).toBe(
        constants.O_NOFOLLOW,
      );
    }
    return fs.open(selected, flags, mode);
  });
  await trace(true);
  expect(selectedFlags).toHaveLength(3);
});

it.each([
  ["scoped magic", true, 1, true],
  ["scoped image", false, 1, true],
  ["scoped digest", false, 2, true],
  ["unscoped magic", true, 1, false],
  ["unscoped image", false, 1, false],
  ["unscoped digest", false, 2, false],
] as const)(
  "rejects a nonregular replacement descriptor before %s reads and closes its owner",
  async (_route, enumerateRoots, selectedOpen, scoped) => {
    const { path, token, trace, traceUnscoped } = await fixture();
    let count = 0;
    let reads: ReturnType<typeof vi.spyOn> | undefined;
    let closes: ReturnType<typeof vi.spyOn> | undefined;
    let selectedFlags: number | undefined;
    vi.mocked(open).mockImplementation(async (selected, flags, mode) => {
      // Open only the authored regular fixture, then simulate replacement metadata.
      const handle = await fs.open(selected, flags, mode);
      if (selected === path && ++count === selectedOpen) {
        selectedFlags = flags as number;
        const actualStat = handle.stat.bind(handle);
        vi.spyOn(handle, "stat").mockImplementation(async (options) => {
          const metadata = await actualStat(options);
          Object.defineProperty(metadata, "isFile", { value: () => false });
          return metadata;
        });
        reads = vi.spyOn(handle, "read");
        closes = vi.spyOn(handle, "close");
      }
      return handle;
    });
    const invoke = scoped ? trace : traceUnscoped;
    await expect(invoke(enumerateRoots)).rejects.toBeInstanceOf(
      scoped ? AnalysisCapabilityUnavailableError : ArtifactReaderFailure,
    );
    expect(reads).toHaveBeenCalledTimes(0);
    expect(closes).toHaveBeenCalledTimes(1);
    expect(selectedFlags! & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    expect(ownedStaticFixturePendingCleanupCount(token)).toBe(0);
  },
);
