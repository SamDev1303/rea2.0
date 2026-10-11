import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";

import { digestOwnedFixtureInput } from "../../../src/application/investigationSafety/OwnedFixturePolicy.js";
import type { TestProcesses } from "../process/processFixture.js";
import { runOwnedCliFixture } from "./ownedCliFixture.js";
import { NativeMacOSProvider } from "../../../src/native/NativeMacOSProvider.js";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";

interface DeclaredInventory {
  readonly root: string;
  readonly directories: readonly string[];
  readonly files: readonly string[];
}

/** Read only the synthetic files declared by the test; never discover grants. */
const inventoryFiles = async ({ root, files }: DeclaredInventory) =>
  Promise.all(
    files.map(async (relativePath) => {
      const path = join(root, relativePath);
      return {
        path,
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
        role: "dependency" as const,
      };
    }),
  );

/** One fixed default CLI request, bound to the caller's complete app inventory. */
export const runOwnedInterfaceBuilderCli = async (
  processes: TestProcesses,
  inventory: DeclaredInventory,
) =>
  runOwnedCliFixture(processes, {
    arguments: ["decode-interface-builder", inventory.root, "--json"],
    policy: {
      roots: [inventory.root],
      files: await inventoryFiles(inventory),
      static_inventory: {
        directories: inventory.directories.map((path) =>
          join(inventory.root, path),
        ),
      },
      endpoints: [],
      environment: [],
      available_capabilities: ["owned-apple-static-fixture"],
      grants: [
        {
          operation: "decode-interface-builder",
          input_digest: digestOwnedFixtureInput({
            args: { path: inventory.root },
            options: {
              maxDocuments: 64,
              maxObjects: 20000,
              maxConnections: 40000,
            },
          }),
          capability: "owned-apple-static-fixture",
          mode: "owned-static",
          port_id: "controller-owned-apple-static-port",
        },
      ],
    },
  });

/** The supplied carrier contains exactly this already oracle-checked archive. */
export const runOwnedKeyedArchiveCli = async (
  processes: TestProcesses,
  fixture: {
    readonly root: string;
    readonly path: string;
    readonly digest: string;
  },
) =>
  runOwnedCliFixture(processes, {
    arguments: ["inspect-keyed-archive", fixture.path, "--json"],
    policy: {
      roots: [fixture.root],
      files: [
        {
          path: fixture.path,
          sha256: fixture.digest,
          role: "dependency",
        },
      ],
      static_inventory: { directories: [] },
      endpoints: [],
      environment: [],
      available_capabilities: ["owned-apple-static-fixture"],
      grants: [
        {
          operation: "inspect-keyed-archive",
          input_digest: digestOwnedFixtureInput({
            args: { path: fixture.path, archive: "." },
            options: { offset: 0, limit: 20000 },
          }),
          capability: "owned-apple-static-fixture",
          mode: "owned-static",
          port_id: "controller-owned-apple-static-port",
        },
      ],
    },
  });

/** Exact static dyld request; filesystem authority comes only from the declared inventory. */
export const runOwnedDylibResolutionCli = async (
  processes: TestProcesses,
  fixture: DeclaredInventory & {
    readonly path: string;
    readonly selectedRoots?: readonly string[];
    readonly architecture?: "arm64" | "arm64e" | "x86_64";
  },
) => {
  const options = {
    ...(fixture.selectedRoots === undefined
      ? {}
      : { root: [...fixture.selectedRoots] }),
    ...(fixture.architecture === undefined
      ? {}
      : { architecture: fixture.architecture }),
  };
  return runOwnedCliFixture(processes, {
    arguments: [
      "trace-dylib-resolution",
      fixture.path,
      ...(fixture.selectedRoots?.flatMap((root) => ["--root", root]) ?? []),
      ...(fixture.architecture === undefined
        ? []
        : ["--architecture", fixture.architecture]),
      "--json",
    ],
    policy: {
      roots: [fixture.root],
      files: await inventoryFiles(fixture),
      static_inventory: {
        directories: fixture.directories.map((path) =>
          join(fixture.root, path),
        ),
      },
      endpoints: [],
      environment: [],
      available_capabilities: ["owned-apple-static-fixture"],
      grants: [
        {
          operation: "trace-dylib-resolution",
          input_digest: digestOwnedFixtureInput({
            args: { path: fixture.path },
            options,
          }),
          capability: "owned-apple-static-fixture",
          mode: "owned-static",
          port_id: "controller-owned-apple-static-port",
        },
      ],
    },
  });
};

/** Fixed passive producer coverage for caller-created trusted synthetic targets.
 * Installed native tools inspect bytes; this grants no public CLI authority.
 */
export const inspectSyntheticNative = async (
  target: { readonly path: string; readonly app?: string },
  operation: "inspect_plist" | "inspect_macho" | "inspect_signature",
  selected?: string,
) => {
  const resolved =
    operation === "inspect_plist"
      ? undefined
      : await parseBinaryTarget(target.path);
  if (resolved !== undefined && !resolved.ok) throw resolved.error;
  if (
    resolved?.ok &&
    (resolved.value.kind !== "executable" || resolved.value.format !== "mach-o")
  )
    throw new Error(
      "Only declared synthetic Mach-O targets may use these passive tools",
    );
  const binaryTarget = resolved?.ok
    ? resolved.value
    : {
        path: target.path,
        ...(target.app === undefined
          ? {}
          : {
              sourcePath: target.app,
              bundleInfoPlist: join(target.app, "Contents/Info.plist"),
            }),
        sha256: createHash("sha256")
          .update(await readFile(target.path))
          .digest("hex"),
        kind: "executable" as const,
        format: "mach-o" as const,
        architecture: "arm64" as const,
        availableArchitectures: ["arm64" as const],
      };
  const client = new NativeMacOSProvider({}).createClient(binaryTarget);
  try {
    return await client.execute(
      operation,
      selected === undefined ? {} : { path: selected },
    );
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
};

/** Preserve plist selection coverage without granting any runtime operation. */
export const inspectSyntheticPlist = (
  target: { readonly path: string; readonly app?: string },
  selected?: string,
) => inspectSyntheticNative(target, "inspect_plist", selected);

/** Inspect authored symbol strings against a trusted copied identity artifact. */
export const demangleSyntheticSymbols = async (
  path: string,
  symbols: readonly string[],
) => {
  const target = await parseBinaryTarget(path);
  if (!target.ok) throw target.error;
  if (target.value.kind !== "executable" || target.value.format !== "mach-o")
    throw new Error("Synthetic demangle identity must be a Mach-O target");
  const client = new NativeMacOSProvider({}).createClient(target.value);
  try {
    return await client.execute("demangle_swift", { symbols: [...symbols] });
  } finally {
    expect(await client.close()).toEqual({ ok: true, value: null });
  }
};
