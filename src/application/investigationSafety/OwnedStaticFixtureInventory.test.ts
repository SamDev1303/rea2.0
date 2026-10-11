import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOwnedAppleStaticSession } from "../binary/OwnedAppleStaticSession.js";
import {
  admitOwnedFixtureOperation,
  attachOwnedFixturePolicy,
  digestOwnedFixtureInput,
  registerOwnedFixtureHandlerPort,
  registerOwnedFixtureHandlerEnvironment,
  sealOwnedFixturePolicy,
} from "./OwnedFixturePolicy.js";
import { runOwnedFixtureExecution } from "./OwnedFixtureExecution.js";
import {
  admitOwnedStaticFixtureRead,
  assertOwnedStaticFixtureAcquisition,
  assertOwnedStaticFixtureDescriptor,
  requireOwnedStaticFixtureInventory,
  revalidateOwnedStaticFixtureInventory,
  sealOwnedStaticFixtureInventory,
  withOwnedStaticFixtureInventory,
  withBoundedOwnedStaticFixtureInventory,
  type OwnedStaticFixtureInventoryToken,
} from "./OwnedStaticFixtureInventory.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots
      .splice(0)
      .map((path) => fs.rm(path, { recursive: true, force: true })),
  );
});
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const fixture = async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "rea-owned-static-")),
  );
  roots.push(root);
  const directory = join(root, "assets");
  await fs.mkdir(directory);
  const file = join(directory, "data.plist");
  await fs.writeFile(file, "synthetic-data");
  const data = {
    roots: [root],
    directories: [directory],
    files: [{ path: file, sha256: hash("synthetic-data") }],
  };
  return { root, directory, file, data };
};
const policyData = (
  data: Awaited<ReturnType<typeof fixture>>["data"],
  input: unknown,
  operation = "open_binary",
) => ({
  roots: data.roots,
  files: data.files.map((file) => ({ ...file, role: "dependency" })),
  static_inventory: { directories: data.directories },
  environment: [],
  endpoints: [],
  available_capabilities: ["owned-apple-static"],
  grants: [
    {
      operation,
      input_digest: digestOwnedFixtureInput(input),
      capability: "owned-apple-static",
      mode: "owned-static",
      port_id: "apple-static",
    },
  ],
});

describe("sealed finite owned static inventory", () => {
  it("admits listed files/directories and bounded optional absence, but not absent bytes", async () => {
    const { root, directory, file, data } = await fixture();
    const token = await sealOwnedStaticFixtureInventory(data);
    await admitOwnedStaticFixtureRead(token, root, "directory");
    await admitOwnedStaticFixtureRead(token, file, "file");
    await expect(
      admitOwnedStaticFixtureRead(
        token,
        join(directory, "optional.plist"),
        "metadata",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      admitOwnedStaticFixtureRead(
        token,
        join(directory, "optional.plist"),
        "file",
      ),
    ).rejects.toMatchObject({ _tag: "AnalysisCapabilityUnavailableError" });
    await expect(
      admitOwnedStaticFixtureRead(
        token,
        join(root, "outside", "optional"),
        "metadata",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not grant permission or establish a controller outside its active scope", async () => {
    await assertOwnedStaticFixtureAcquisition("/unlisted", "file");
    expect(() =>
      requireOwnedStaticFixtureInventory({}, "open_binary"),
    ).toThrow();
    expect(() =>
      assertOwnedStaticFixtureDescriptor("/unlisted", {
        dev: 0,
        ino: 0,
        size: 0,
        nlink: 1,
        isFile: () => true,
      }),
    ).not.toThrow();
  });
  it("binds scope to actual owner and exact selected operation without an open wildcard", async () => {
    const { file, data } = await fixture();
    const token = await sealOwnedStaticFixtureInventory(data);
    const owner = {};
    await withOwnedStaticFixtureInventory(
      token,
      owner,
      "decode_interface_builder",
      async () => {
        expect(() =>
          requireOwnedStaticFixtureInventory(owner, "open_binary"),
        ).toThrow();
        expect(
          requireOwnedStaticFixtureInventory(owner, "decode_interface_builder"),
        ).toBe(token);
        expect(() =>
          requireOwnedStaticFixtureInventory({}, "open_binary"),
        ).toThrow();
        expect(() =>
          requireOwnedStaticFixtureInventory(owner, "inspect_keyed_archive"),
        ).toThrow();
        await assertOwnedStaticFixtureAcquisition(file, "file");
        assertOwnedStaticFixtureDescriptor(
          file,
          await fs.stat(file, { bigint: true }),
        );
        expect(() =>
          assertOwnedStaticFixtureDescriptor(file, {
            dev: 0,
            ino: 0,
            size: 14,
            nlink: 1,
            isFile: () => true,
          }),
        ).toThrow();
      },
    );
    expect(() =>
      requireOwnedStaticFixtureInventory(owner, "open_binary"),
    ).toThrow();
  });
  it("rejects forged tokens", async () => {
    const forged = {} as OwnedStaticFixtureInventoryToken;
    await expect(
      revalidateOwnedStaticFixtureInventory(forged),
    ).rejects.toMatchObject({ _tag: "AnalysisCapabilityUnavailableError" });
    expect(() =>
      withOwnedStaticFixtureInventory(
        forged,
        {},
        "open_binary",
        () => undefined,
      ),
    ).toThrow();
  });
  it("rejects unlisted children before reading any file bytes", async () => {
    const { directory, data } = await fixture();
    await fs.writeFile(join(directory, "unlisted"), "do not ingest");
    const open = vi.spyOn(fs, "open");
    await expect(sealOwnedStaticFixtureInventory(data)).rejects.toMatchObject({
      _tag: "AnalysisCapabilityUnavailableError",
    });
    expect(open).not.toHaveBeenCalled();
  });
  it.each(["symlink", "hardlink", "protected"] as const)(
    "rejects %s descendants before bytes",
    async (mode) => {
      const { directory, file, data } = await fixture();
      if (mode === "symlink") {
        await fs.rm(file);
        await fs.symlink("/etc/hosts", file);
      }
      if (mode === "hardlink") await fs.link(file, join(directory, "alias"));
      if (mode === "protected") await fs.mkdir(join(directory, ".ssh"));
      const open = vi.spyOn(fs, "open");
      await expect(sealOwnedStaticFixtureInventory(data)).rejects.toMatchObject(
        { _tag: "AnalysisCapabilityUnavailableError" },
      );
      expect(open).not.toHaveBeenCalled();
    },
  );
});

describe("owned static inventory mutation and descriptor checks", () => {
  it.each(["addition", "removal", "replacement", "changed bytes"] as const)(
    "rejects %s after sealing",
    async (mode) => {
      const { directory, file, data } = await fixture();
      const token = await sealOwnedStaticFixtureInventory(data);
      if (mode === "addition") await fs.writeFile(join(directory, "new"), "x");
      if (mode === "removal") await fs.rm(file);
      if (mode === "replacement") {
        await fs.rm(file);
        await fs.writeFile(file, "synthetic-data");
      }
      if (mode === "changed bytes") await fs.writeFile(file, "synthetic-bad!");
      await expect(
        revalidateOwnedStaticFixtureInventory(token),
      ).rejects.toMatchObject({ _tag: "AnalysisCapabilityUnavailableError" });
      await expect(
        admitOwnedStaticFixtureRead(token, file, "file"),
      ).rejects.toMatchObject({ _tag: "AnalysisCapabilityUnavailableError" });
    },
  );
  it("checks opened inode before the first hash read, including initial sealing", async () => {
    const { file, data } = await fixture();
    const originalOpen = fs.open;
    let reads = 0;
    vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
      if (path === file) {
        await fs.rename(file, join(data.roots[0]!, "old"));
        await fs.writeFile(file, "synthetic-data");
      }
      const handle = await originalOpen(path, flags, mode);
      const originalRead = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(
        (...args: Parameters<typeof handle.read>) => {
          ++reads;
          return originalRead(...args);
        },
      );
      return handle;
    });
    await expect(sealOwnedStaticFixtureInventory(data)).rejects.toMatchObject({
      _tag: "AnalysisCapabilityUnavailableError",
    });
    expect(reads).toBe(0);
  });
  it("checks the sealed inode before revalidation reads", async () => {
    const { file, data } = await fixture();
    const token = await sealOwnedStaticFixtureInventory(data);
    const originalOpen = fs.open;
    let reads = 0;
    vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
      if (path === file) {
        await fs.rename(file, join(data.roots[0]!, "old"));
        await fs.writeFile(file, "synthetic-data");
      }
      const handle = await originalOpen(path, flags, mode);
      const originalRead = handle.read.bind(handle);
      vi.spyOn(handle, "read").mockImplementation(
        (...args: Parameters<typeof handle.read>) => {
          ++reads;
          return originalRead(...args);
        },
      );
      return handle;
    });
    await expect(
      revalidateOwnedStaticFixtureInventory(token),
    ).rejects.toMatchObject({ _tag: "AnalysisCapabilityUnavailableError" });
    expect(reads).toBe(0);
  });
  it("requires complete parent inventory, nonoverlapping roots and bounded entries", async () => {
    const { root, directory, data } = await fixture();
    await expect(
      sealOwnedStaticFixtureInventory({ ...data, directories: [] }),
    ).rejects.toMatchObject({ _tag: "AnalysisCapabilityUnavailableError" });
    await expect(
      sealOwnedStaticFixtureInventory({ ...data, roots: [root, directory] }),
    ).rejects.toMatchObject({ _tag: "AnalysisCapabilityUnavailableError" });
    await expect(
      sealOwnedStaticFixtureInventory({
        ...data,
        directories: Array.from({ length: 257 }, () => directory),
      }),
    ).rejects.toMatchObject({ _tag: "AnalysisCapabilityUnavailableError" });
  });
  it("snapshots controller inventory before awaits", async () => {
    const { data } = await fixture();
    const seal = sealOwnedStaticFixtureInventory(data);
    data.files[0]!.sha256 = hash("wrong");
    const token = await seal;
    await revalidateOwnedStaticFixtureInventory(token);
  });
});

describe("owned static acquisition budgets", () => {
  it.each(["bytes", "acquisitions"] as const)(
    "denies before hashing past the %s budget",
    async (budget) => {
      const { file, data } = await fixture();
      const token = await sealOwnedStaticFixtureInventory(data);
      const limits =
        budget === "bytes"
          ? { maxRevalidationBytes: Buffer.byteLength("synthetic-data") }
          : { maxAcquisitions: 1 };
      await withBoundedOwnedStaticFixtureInventory(token, {}, "open_binary", {
        ...limits,
        run: async () => {
          await assertOwnedStaticFixtureAcquisition(file, "file");
          const open = vi.spyOn(fs, "open");
          await expect(
            assertOwnedStaticFixtureAcquisition(file, "file"),
          ).rejects.toMatchObject({
            _tag: "AnalysisCapabilityUnavailableError",
          });
          expect(open).not.toHaveBeenCalled();
        },
      });
    },
  );
  it("cannot widen controller budget ceilings", async () => {
    const { data } = await fixture();
    const token = await sealOwnedStaticFixtureInventory(data);
    expect(() =>
      withBoundedOwnedStaticFixtureInventory(token, {}, "open_binary", {
        run: () => undefined,
        maxRevalidationBytes: 512 * 1024 * 1024 + 1,
      }),
    ).toThrow();
    expect(() =>
      withBoundedOwnedStaticFixtureInventory(token, {}, "open_binary", {
        run: () => undefined,
        maxAcquisitions: 1025,
      }),
    ).toThrow();
  });
});

describe("owned static policy binding", () => {
  it("requires a constructor-branded actual port and exact operation input", async () => {
    const { file, data } = await fixture();
    const input = { path: file };
    const port = createOwnedAppleStaticSession();
    const token = await sealOwnedFixturePolicy(policyData(data, input), {
      owned_static_ports: [{ port_id: "apple-static", reference: port }],
    });
    const owner = {};
    registerOwnedFixtureHandlerPort(owner, port);
    registerOwnedFixtureHandlerEnvironment(owner, {});
    attachOwnedFixturePolicy(owner, token, port);
    expect(
      await admitOwnedFixtureOperation(
        owner,
        "open_binary",
        { path: "different" },
        port,
      ),
    ).toBeUndefined();
    const admission = await admitOwnedFixtureOperation(
      owner,
      "open_binary",
      input,
      port,
    );
    expect(admission?.mode).toBe("owned-static");
    runOwnedFixtureExecution(admission, () =>
      expect(requireOwnedStaticFixtureInventory(port, "open_binary")).toBe(
        admission?.static_inventory,
      ),
    );
    expect(() =>
      requireOwnedStaticFixtureInventory(port, "open_binary"),
    ).toThrow();
  });
  it("rejects object-spread brand forgery and factory captured port mismatch", async () => {
    const { file, data } = await fixture();
    const port = createOwnedAppleStaticSession();
    await expect(
      sealOwnedFixturePolicy(policyData(data, { path: file }), {
        owned_static_ports: [
          { port_id: "apple-static", reference: { ...port } },
        ],
      }),
    ).rejects.toMatchObject({ _tag: "AnalysisCapabilityUnavailableError" });
    const token = await sealOwnedFixturePolicy(
      policyData(data, { path: file }),
      { owned_static_ports: [{ port_id: "apple-static", reference: port }] },
    );
    const owner = {};
    registerOwnedFixtureHandlerPort(owner, createOwnedAppleStaticSession());
    registerOwnedFixtureHandlerEnvironment(owner, {});
    expect(() => attachOwnedFixturePolicy(owner, token, port)).toThrow();
  });
  it.each(["capture_process", "inspect_plist", "decompile"])(
    "does not admit unrelated %s",
    async (operation) => {
      const { data } = await fixture();
      const port = createOwnedAppleStaticSession();
      await expect(
        sealOwnedFixturePolicy(policyData(data, {}, operation), {
          owned_static_ports: [{ port_id: "apple-static", reference: port }],
        }),
      ).rejects.toMatchObject({ _tag: "AnalysisCapabilityUnavailableError" });
    },
  );
  it("rejects runtime environment, executable role and mixed grant profiles", async () => {
    const { data } = await fixture();
    const port = createOwnedAppleStaticSession();
    const bindings = {
      owned_static_ports: [{ port_id: "apple-static", reference: port }],
    };
    const base = policyData(data, {});
    await expect(
      sealOwnedFixturePolicy(
        { ...base, environment: [{ name: "LANG", value: "C" }] },
        bindings,
      ),
    ).rejects.toMatchObject({ _tag: "AnalysisCapabilityUnavailableError" });
    await expect(
      sealOwnedFixturePolicy(
        {
          ...base,
          files: base.files.map((file) => ({ ...file, role: "executable" })),
        },
        bindings,
      ),
    ).rejects.toMatchObject({ _tag: "AnalysisCapabilityUnavailableError" });
    await expect(
      sealOwnedFixturePolicy(
        {
          ...base,
          grants: [
            ...base.grants,
            { ...base.grants[0], mode: "nonexecuting-stub" },
          ],
        },
        bindings,
      ),
    ).rejects.toMatchObject({ _tag: "AnalysisCapabilityUnavailableError" });
  });
  it("revalidates all children before dispatch and still has no public/default grant", async () => {
    const { directory, file, data } = await fixture();
    const port = createOwnedAppleStaticSession();
    const input = { path: file };
    expect(
      await admitOwnedFixtureOperation({}, "open_binary", input, port),
    ).toBeUndefined();
    const token = await sealOwnedFixturePolicy(policyData(data, input), {
      owned_static_ports: [{ port_id: "apple-static", reference: port }],
    });
    const owner = {};
    registerOwnedFixtureHandlerPort(owner, port);
    registerOwnedFixtureHandlerEnvironment(owner, {});
    attachOwnedFixturePolicy(owner, token, port);
    await fs.writeFile(join(directory, "new"), "unlisted");
    await expect(
      admitOwnedFixtureOperation(owner, "open_binary", input, port),
    ).rejects.toMatchObject({ _tag: "AnalysisCapabilityUnavailableError" });
  });
});

it("rejects an owned static factory environment omitted from the empty sealed map", async () => {
  const { file, data } = await fixture();
  const port = createOwnedAppleStaticSession();
  const token = await sealOwnedFixturePolicy(policyData(data, { path: file }), {
    owned_static_ports: [{ port_id: "apple-static", reference: port }],
  });
  const owner = {};
  registerOwnedFixtureHandlerPort(owner, port);
  registerOwnedFixtureHandlerEnvironment(owner, { REA_LOG_LEVEL: "silent" });
  expect(() => attachOwnedFixturePolicy(owner, token, port)).toThrow();
});
