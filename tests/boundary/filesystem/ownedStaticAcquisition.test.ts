import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { readRegularFile } from "../../../src/application/RegularFileRead.js";
import {
  sealOwnedStaticFixtureInventory,
  withOwnedStaticFixtureInventory,
} from "../../../src/application/investigationSafety/OwnedStaticFixtureInventory.js";
import { DirectoryArtifactReader } from "../../../src/artifacts/DirectoryArtifactReader.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const fixture = async () => {
  const root = await createTestTempDirectory("rea2-static-acquisition-");
  const path = join(root, "archive.plist");
  const bytes = Buffer.from("SYNTHETIC_ARCHIVE_BYTES");
  await fs.writeFile(path, bytes);
  const token = await sealOwnedStaticFixtureInventory({
    roots: [root],
    directories: [],
    files: [{ path, sha256: createHash("sha256").update(bytes).digest("hex") }],
  });
  return { root, path, bytes, token };
};

describe("actual reader acquisition under an owned static inventory", () => {
  it("rejects a changed opened leaf before the regular-file consumer reads it", async () => {
    const { path, token } = await fixture();
    const metadata = await fs.stat(path);
    const read = vi.fn();
    const close = vi.fn(async () => undefined);
    const replacement = {
      stat: async () => ({
        ...metadata,
        ino: metadata.ino + 1,
        isFile: () => true,
      }),
      read,
      close,
    } as unknown as FileHandle;
    const original = (
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      )
    ).open;
    let opens = 0;
    const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      // Inventory hashing uses its private default-fs adapter. This named
      // binding controls the subsequent parser descriptor acquisition only.
      if (args[0] === path && ++opens === 1) return replacement;
      return original(...args);
    });
    try {
      await expect(
        withOwnedStaticFixtureInventory(
          token,
          {},
          "inspect_keyed_archive",
          () => readRegularFile(path),
        ),
      ).rejects.toThrow();
      expect(opens).toBe(1);
      expect(read).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      open.mockRestore();
    }
  });

  it("rejects an added protected descendant before the parser enumerates it", async () => {
    const { root, token } = await fixture();
    await fs.writeFile(join(root, ".env"), "SYNTHETIC_PRIVATE_MARKER");
    const reader = new DirectoryArtifactReader(root);
    const parserOpen = vi.spyOn(reader, "open");
    const observed: string[] = [];
    try {
      await expect(
        withOwnedStaticFixtureInventory(
          token,
          {},
          "inspect_keyed_archive",
          async () => {
            for await (const entry of reader.entries())
              observed.push(entry.path);
          },
        ),
      ).rejects.toThrow();
      expect(observed).toEqual([]);
      expect(parserOpen).not.toHaveBeenCalled();
    } finally {
      parserOpen.mockRestore();
      await reader.close();
    }
  });
});
