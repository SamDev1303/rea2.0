import { lstat, open, readdir, writeFile, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { writeTextParts } from "../../../src/application/JsonFiles.js";
import {
  JsonWriteCleanupFailure,
  retryPendingJsonWriteCleanup,
  withJsonWriteResources,
} from "../../../src/application/JsonWriteResources.js";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, open: vi.fn(fs.open), rmdir: vi.fn(fs.rmdir) };
});

it("retains a real staging descriptor and original text failure without publishing", async () => {
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const root = await createTestTempDirectory("rea-write-close-");
  const destination = join(root, "bundle.json");
  let allowClose = false;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  vi.mocked(open).mockImplementation(async (...args) => {
    const opened = await fs.open(...args);
    handle = opened;
    const close = opened.close.bind(opened);
    vi.spyOn(opened, "close").mockImplementation(async () => {
      if (!allowClose) throw new Error("staging descriptor close failed");
      await close();
    });
    return opened;
  });
  function* parts() {
    yield "partial";
    throw new Error("original text generation failed");
  }
  let failure: JsonWriteCleanupFailure | undefined;
  try {
    const result = await writeTextParts(parts(), destination, false);
    expect(result.ok).toBe(false);
    if (result.ok || !(result.error instanceof JsonWriteCleanupFailure))
      throw new Error("Write owner lost");
    failure = result.error;
    expect(failure.cleanupIncomplete).toBe(true);
    expect((failure.cause as AggregateError).errors).toMatchObject([
      { message: "original text generation failed" },
      { message: "staging descriptor close failed" },
    ]);
    expect(handle!.fd).toBeGreaterThanOrEqual(0);
    expect(await readdir(root)).toEqual([
      expect.stringContaining(".rea-write-"),
    ]);
    await expect(lstat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.stringify(failure)).not.toContain('"fd"');
    await expect(failure.resources.close()).rejects.toThrow(
      "staging descriptor close failed",
    );
    const one = failure.resources.close();
    const two = failure.resources.close();
    expect(one).toBe(two);
    await Promise.allSettled([one, two]);
  } finally {
    allowClose = true;
    await failure?.resources.close();
    await retryPendingJsonWriteCleanup();
    vi.mocked(open).mockReset();
    if (handle !== undefined) expect(handle.fd).toBe(-1);
    expect(await readdir(root)).toEqual([]);
  }
});

it("retains unexpected staging descendants rather than recursively deleting them", async () => {
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(open).mockImplementation(fs.open);
  const root = await createTestTempDirectory("rea-write-inventory-");
  let failure: JsonWriteCleanupFailure | undefined;
  try {
    await withJsonWriteResources(join(root, "bundle"), async (resources) => {
      await resources.acquire();
      await writeFile(join(resources.directory, "unexpected"), "retained");
    }).catch((cause: unknown) => {
      if (!(cause instanceof JsonWriteCleanupFailure)) throw cause;
      failure = cause;
    });
    expect(failure).toBeInstanceOf(JsonWriteCleanupFailure);
    expect(await readdir(failure!.resources.directory)).toEqual(["unexpected"]);
    await expect(failure!.resources.close()).rejects.toMatchObject({
      code: "ENOTEMPTY",
    });
  } finally {
    if (failure) {
      await rm(join(failure.resources.directory, "unexpected"));
      await failure.resources.close();
    }
    await retryPendingJsonWriteCleanup();
    vi.mocked(open).mockReset();
  }
});

it("preserves both generation and iterator-return failures", async () => {
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  vi.mocked(open).mockImplementation(fs.open);
  const root = await createTestTempDirectory("rea-write-iterator-");
  const result = await writeTextParts(
    {
      [Symbol.iterator]: () => ({
        next() {
          throw new Error("generation failed");
        },
        return() {
          throw new Error("iterator return failed");
        },
      }),
    },
    join(root, "bundle"),
    false,
  );
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("Expected failure");
  expect((result.error.cause as AggregateError).errors).toMatchObject([
    { message: "generation failed" },
    { message: "iterator return failed" },
  ]);
  expect(await readdir(root)).toEqual([]);
  vi.mocked(open).mockReset();
});

it("retains original write failure and distinct actual descriptor retry faults", async () => {
  const fs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const root = await createTestTempDirectory("rea-write-retry-causes-");
  const primary = new Error("generation failed");
  const faults = [
    new Error("close0"),
    new Error("close1"),
    new Error("close2"),
  ];
  let allowed = false;
  let index = 0;
  vi.mocked(open).mockImplementation(async (...args) => {
    const h = await fs.open(...args);
    const close = h.close.bind(h);
    vi.spyOn(h, "close").mockImplementation(async () => {
      if (!allowed) throw faults[index++];
      await close();
    });
    return h;
  });
  const tree = (v: unknown): unknown[] =>
    v instanceof AggregateError
      ? [v, ...v.errors.flatMap(tree)]
      : v instanceof Error && v.cause !== undefined
        ? [v, ...tree(v.cause)]
        : [v];
  try {
    await withJsonWriteResources(join(root, "bundle"), async (resources) => {
      await resources.acquire();
      throw primary;
    }).catch(() => {});
    await retryPendingJsonWriteCleanup().catch(() => {});
    const last = await retryPendingJsonWriteCleanup().catch(
      (cause: unknown) => cause,
    );
    expect(tree(last)).toContain(primary);
    for (const fault of faults) expect(tree(last)).toContain(fault);
  } finally {
    allowed = true;
    await retryPendingJsonWriteCleanup();
    vi.mocked(open).mockReset();
  }
  expect(await readdir(root)).toEqual([]);
});

it.each([true, false])(
  "retains actual published path, bytes and result after staging cleanup fails (overwrite %s)",
  async (overwrite) => {
    const fs =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    vi.mocked(open).mockImplementation(fs.open);
    const root = await createTestTempDirectory("rea-published-cleanup-");
    const destination = join(root, "bundle");
    const faults = [
      new Error("staging removal0"),
      new Error("staging removal1"),
    ];
    let index = 0;
    let allowed = false;
    vi.mocked(rmdir).mockImplementation(async (...args) => {
      if (!allowed) throw faults[index++];
      return fs.rmdir(...args);
    });
    const tree = (v: unknown): unknown[] =>
      v instanceof AggregateError
        ? [v, ...v.errors.flatMap(tree)]
        : v instanceof Error && v.cause !== undefined
          ? [v, ...tree(v.cause)]
          : [v];
    try {
      const result = await writeTextParts(
        ["published"],
        destination,
        overwrite,
      );
      expect(result.ok).toBe(false);
      if (result.ok || !(result.error instanceof JsonWriteCleanupFailure))
        throw new Error("Publication owner missing");
      expect(result.error.outcome).toEqual({ kind: "completed", value: 9 });
      expect(result.error.publication).toEqual({
        path: destination,
        bytes: 9,
        state: "published",
      });
      expect(result.error.path).toBe(destination);
      expect(result.error.userMessage).toContain("9 bytes");
      expect(await fs.readFile(destination, "utf8")).toBe("published");
      const retry = await retryPendingJsonWriteCleanup().catch(
        (cause: unknown) => cause,
      );
      for (const fault of faults) expect(tree(retry)).toContain(fault);
      const typed = tree(retry).find(
        (x) => x instanceof JsonWriteCleanupFailure,
      ) as JsonWriteCleanupFailure;
      expect(typed.outcome).toEqual({ kind: "completed", value: 9 });
      expect(typed.publication).toEqual(result.error.publication);
    } finally {
      allowed = true;
      await retryPendingJsonWriteCleanup();
      vi.mocked(open).mockReset();
      vi.mocked(rmdir).mockImplementation(fs.rmdir);
    }
    expect(await readdir(root)).toEqual(["bundle"]);
  },
);
