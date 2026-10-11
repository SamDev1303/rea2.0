import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";
import { OwnedDirectoryHandle } from "../../filesystem/OwnedDirectoryHandle.js";
import {
  OwnedStaticFixtureCleanupFailure,
  OwnedStaticFixtureResourceBank,
  withOwnedStaticFixtureResource,
} from "./OwnedStaticFixtureResources.js";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  absentMetadata,
  throwOwnedStaticFixtureAbsentMetadata,
} from "./OwnedStaticFixtureMetadata.js";
import {
  isProtectedHostPath,
  isProtectedReferencePath,
} from "../../filesystem/ProtectedPaths.js";
import { withOwnedStaticReadBoundary } from "../../filesystem/OwnedStaticReadBoundary.js";
export {
  assertOwnedStaticFixtureAcquisition,
  assertOwnedStaticFixtureDescriptor,
} from "../../filesystem/OwnedStaticReadBoundary.js";
import { admitInvestigationPath } from "./InvestigationAdmission.js";
import {
  ownedFixtureUnavailable,
  snapshotOwnedFixtureInput,
} from "./OwnedFixturePolicyData.js";
import {
  identifyOwnedFixtureDirectory,
  withinOwnedFixtureRoot,
} from "./OwnedFixturePolicyRuntime.js";

declare const inventoryBrand: unique symbol;
export type OwnedStaticFixtureInventoryToken = {
  readonly [inventoryBrand]: true;
};
interface Identity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}
interface FileIdentity extends Identity {
  readonly size: number;
  readonly sha256: string;
}
interface Inventory {
  readonly directories: ReadonlyMap<string, Identity>;
  readonly files: ReadonlyMap<string, FileIdentity>;
  readonly children: ReadonlyMap<string, readonly string[]>;
  readonly bytes: number;
  readonly resources: OwnedStaticFixtureResourceBank;
}
export interface OwnedStaticFixtureInventoryData {
  readonly roots: readonly string[];
  readonly directories: readonly string[];
  readonly files: readonly { readonly path: string; readonly sha256: string }[];
}
export interface OwnedStaticFixtureDescriptor {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly size: number | bigint;
  readonly nlink: number | bigint;
  isFile(): boolean;
}
import { validateOwnedStaticFixtureOpenBinding } from "./OwnedStaticFixtureBinding.js";
const inventories = new WeakMap<object, Inventory>();
interface InventoryScope {
  token: OwnedStaticFixtureInventoryToken;
  owner: object;
  operation: string;
  remainingBytes: number;
  remainingAcquisitions: number;
  input_digest: string | undefined;
  open_binding: OwnedStaticFixtureOpenBinding | undefined;
}
export interface OwnedStaticFixtureOpenBinding {
  readonly primary_path: string;
  readonly input_digest: string;
  readonly kind: "direct-open" | "cli-stage";
}
const scopes = new AsyncLocalStorage<InventoryScope>();
const fail = (): never => {
  throw ownedFixtureUnavailable("owned_static_fixture");
};
const inventoryFor = (token: OwnedStaticFixtureInventoryToken): Inventory =>
  inventories.get(token) ?? fail();
/** Reject an unlisted primary selection before canonicalization or any filesystem probe. */
export const assertOwnedStaticFixturePrimaryPath = (
  token: OwnedStaticFixtureInventoryToken,
  path: string,
): void => {
  const inventory = inventoryFor(token);
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    (!inventory.files.has(path) && !inventory.directories.has(path)) ||
    isProtectedHostPath(path) ||
    isProtectedReferencePath(path)
  )
    fail();
};
const canonical = async (path: string): Promise<void> => {
  await admitInvestigationPath("owned_static_fixture", path);
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    (await fs.realpath(path)) !== path
  )
    fail();
};
const fileIdentity = async (
  path: string,
  sha256: string,
  remaining: number,
  expected: Pick<FileIdentity, "dev" | "ino" | "size">,
): Promise<FileIdentity> => {
  await canonical(path);
  // Raw no-follow descriptors avoid recursive entry into the shared reader hooks.
  const handle = await fs.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  return withOwnedStaticFixtureResource(
    { kind: "file", owner: new OwnedFileHandle(handle) },
    async () => {
      const before = await handle.stat();
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size > Math.min(remaining, 256 * 1024 * 1024) ||
        before.dev !== expected.dev ||
        before.ino !== expected.ino ||
        before.size !== expected.size
      )
        fail();
      const hash = createHash("sha256");
      const chunk = Buffer.alloc(65536);
      let bytes = 0;
      while (true) {
        const { bytesRead } = await handle.read(
          chunk,
          0,
          Math.min(chunk.length, Math.max(1, before.size - bytes + 1)),
          null,
        );
        if (bytesRead === 0) break;
        bytes += bytesRead;
        if (bytes > before.size) fail();
        hash.update(chunk.subarray(0, bytesRead));
      }
      const after = await handle.stat();
      const pathState = await fs.lstat(path);
      if (
        bytes !== before.size ||
        hash.digest("hex") !== sha256 ||
        !pathState.isFile() ||
        pathState.nlink !== 1 ||
        pathState.dev !== before.dev ||
        pathState.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs ||
        after.nlink !== 1
      )
        fail();
      await canonical(path);
      return Object.freeze({
        path,
        sha256,
        dev: before.dev,
        ino: before.ino,
        size: before.size,
      });
    },
  );
};
const childrenAt = async (
  path: string,
  declaredChildren: readonly string[],
): Promise<readonly string[]> => {
  const children: string[] = [];
  const declared = new Set(declaredChildren);
  const owner = new OwnedDirectoryHandle(await fs.opendir(path));
  return withOwnedStaticFixtureResource(
    { kind: "directory", owner },
    async () => {
      while (true) {
        const entry = await owner.handle.read();
        if (entry === null) break;
        if (children.length >= 1024) fail();
        // An enumerated name is evidence of a namespace change, never authority to follow it.
        if (!declared.has(entry.name)) fail();
        const child = resolve(path, entry.name);
        await admitInvestigationPath("owned_static_fixture", child);
        children.push(entry.name);
      }
      return Object.freeze(children.sort());
    },
  );
};
const sameChildren = (
  left: readonly string[],
  right: readonly string[],
): boolean =>
  left.length === right.length &&
  left.every((name, index) => name === right[index]);
const collectFileMetadata = async (
  selected: OwnedStaticFixtureInventoryData["files"],
  directories: ReadonlyMap<string, Identity>,
): Promise<ReadonlyMap<string, Pick<FileIdentity, "dev" | "ino" | "size">>> => {
  const metadata = new Map<
    string,
    Pick<FileIdentity, "dev" | "ino" | "size">
  >();
  for (const file of selected) {
    if (
      metadata.has(file.path) ||
      directories.has(file.path) ||
      !directories.has(dirname(file.path)) ||
      !/^[a-f0-9]{64}$/u.test(file.sha256)
    )
      fail();
    await canonical(file.path);
    const current = await fs.lstat(file.path);
    if (!current.isFile() || current.nlink !== 1) fail();
    metadata.set(file.path, {
      dev: current.dev,
      ino: current.ino,
      size: current.size,
    });
  }
  return metadata;
};

/** Controller supplies every entry; enumerating an unknown entry never grants it. */
export const sealOwnedStaticFixtureInventory = async (
  value: OwnedStaticFixtureInventoryData,
): Promise<OwnedStaticFixtureInventoryToken> => {
  try {
    const data = snapshotOwnedFixtureInput(value);
    if (
      data.roots.length === 0 ||
      data.roots.length > 32 ||
      data.directories.length > 256 ||
      data.files.length > 256
    )
      fail();
    const directories = new Map<string, Identity>();
    const files = new Map<string, FileIdentity>();
    const roots = data.roots;
    if (
      new Set(roots).size !== roots.length ||
      roots.some((root, index) =>
        roots.some(
          (other, otherIndex) =>
            index !== otherIndex && withinOwnedFixtureRoot(other, root),
        ),
      )
    )
      fail();
    for (const path of [...roots, ...data.directories]) {
      if (
        directories.has(path) ||
        !roots.some((root) => withinOwnedFixtureRoot(root, path))
      )
        fail();
      directories.set(path, await identifyOwnedFixtureDirectory(path));
    }
    for (const path of data.directories)
      if (!directories.has(dirname(path))) fail();
    // Metadata admission precedes every byte read; complete child membership is checked before hashing.
    const fileMetadata = await collectFileMetadata(data.files, directories);
    const children = new Map<string, readonly string[]>();
    const declared = [
      ...directories.keys(),
      ...data.files.map((file) => file.path),
    ];
    for (const path of directories.keys()) {
      const expected = declared
        .filter((child) => child !== path && dirname(child) === path)
        .map((child) => child.slice(path.length + 1))
        .sort();
      const observed = await childrenAt(path, expected);
      if (!sameChildren(expected, observed)) fail();
      children.set(path, Object.freeze(expected));
    }
    let budget = 512 * 1024 * 1024;
    for (const file of data.files) {
      const identity = await fileIdentity(
        file.path,
        file.sha256,
        budget,
        fileMetadata.get(file.path) ?? fail(),
      );
      budget -= identity.size;
      files.set(file.path, identity);
    }
    const token = Object.freeze({}) as OwnedStaticFixtureInventoryToken;
    inventories.set(token, {
      directories,
      files,
      children,
      bytes: 512 * 1024 * 1024 - budget,
      resources: new OwnedStaticFixtureResourceBank(),
    });
    await revalidateOwnedStaticFixtureInventory(token);
    return token;
  } catch (cause: unknown) {
    if (cause instanceof OwnedStaticFixtureCleanupFailure) throw cause;
    return fail();
  }
};
export const revalidateOwnedStaticFixtureInventory = async (
  token: OwnedStaticFixtureInventoryToken,
): Promise<void> => {
  try {
    const inventory = inventoryFor(token);
    inventory.resources.assertReady();
    for (const directory of inventory.directories.values()) {
      const current = await identifyOwnedFixtureDirectory(directory.path);
      if (
        current.dev !== directory.dev ||
        current.ino !== directory.ino ||
        !sameChildren(
          inventory.children.get(directory.path) ?? fail(),
          await childrenAt(
            directory.path,
            inventory.children.get(directory.path) ?? fail(),
          ),
        )
      )
        fail();
    }
    let budget = 512 * 1024 * 1024;
    for (const file of inventory.files.values()) {
      const current = await fileIdentity(file.path, file.sha256, budget, file);
      budget -= current.size;
      if (
        current.dev !== file.dev ||
        current.ino !== file.ino ||
        current.size !== file.size
      )
        fail();
    }
  } catch (cause: unknown) {
    if (cause instanceof OwnedStaticFixtureCleanupFailure) {
      inventoryFor(token).resources.retain(cause);
      throw cause;
    }
    fail();
  }
};
export const retryOwnedStaticFixtureCleanup = (
  token: OwnedStaticFixtureInventoryToken,
): Promise<void> => inventoryFor(token).resources.retry();
export const ownedStaticFixturePendingCleanupCount = (
  token: OwnedStaticFixtureInventoryToken,
): number => inventoryFor(token).resources.pendingCount;
export const admitOwnedStaticFixtureRead = async (
  token: OwnedStaticFixtureInventoryToken,
  path: string,
  kind: "file" | "directory" | "metadata",
): Promise<void> => {
  const inventory = inventoryFor(token);
  if (!["file", "directory", "metadata"].includes(kind)) fail();
  if (!isAbsolute(path) || resolve(path) !== path || path.length > 4096) fail();
  if (kind === "file" && !inventory.files.has(path)) fail();
  if (kind === "directory" && !inventory.directories.has(path)) fail();
  const unknownMetadata =
    kind === "metadata" &&
    !inventory.files.has(path) &&
    !inventory.directories.has(path);
  if (unknownMetadata && !absentMetadata(inventory, path)) fail();
  if (isProtectedHostPath(path) || isProtectedReferencePath(path)) fail();
  await revalidateOwnedStaticFixtureInventory(token);
  if (unknownMetadata) throwOwnedStaticFixtureAbsentMetadata();
  await admitInvestigationPath("owned_static_fixture", path);
};
export const withBoundedOwnedStaticFixtureInventory = <T>(
  token: OwnedStaticFixtureInventoryToken,
  owner: object,
  operation: string,
  selected: {
    readonly run: () => T;
    readonly maxRevalidationBytes?: number;
    readonly maxAcquisitions?: number;
    readonly input_digest?: string;
    readonly open_binding?: OwnedStaticFixtureOpenBinding;
  },
): T => {
  inventoryFor(token);
  if (
    ![
      "open_binary",
      "decode_interface_builder",
      "inspect_keyed_archive",
      "trace_dylib_resolution",
    ].includes(operation)
  )
    fail();
  const remainingBytes = selected.maxRevalidationBytes ?? 512 * 1024 * 1024;
  const remainingAcquisitions = selected.maxAcquisitions ?? 1024;
  if (
    !Number.isSafeInteger(remainingBytes) ||
    remainingBytes < 0 ||
    remainingBytes > 512 * 1024 * 1024 ||
    !Number.isSafeInteger(remainingAcquisitions) ||
    remainingAcquisitions < 0 ||
    remainingAcquisitions > 1024
  )
    fail();
  const scope: InventoryScope = {
    token,
    owner,
    operation,
    remainingBytes,
    remainingAcquisitions,
    input_digest: selected.input_digest,
    open_binding: validateOwnedStaticFixtureOpenBinding(
      inventoryFor(token),
      operation,
      selected,
    ),
  };
  return scopes.run(scope, () =>
    withOwnedStaticReadBoundary(
      Object.freeze({
        retainCleanup: (failure: OwnedStaticFixtureCleanupFailure) =>
          inventoryFor(token).resources.retain(failure),
        acquire: (path: string, kind: "file" | "directory" | "metadata") =>
          acquireWithinScope(scope, path, kind),
        descriptor: (path: string, metadata: OwnedStaticFixtureDescriptor) =>
          verifyDescriptor(inventoryFor(token), path, metadata),
      }),
      selected.run,
    ),
  );
};
export const withOwnedStaticFixtureInventory = <T>(
  token: OwnedStaticFixtureInventoryToken,
  owner: object,
  operation: string,
  run: () => T,
): T =>
  withBoundedOwnedStaticFixtureInventory(token, owner, operation, { run });
export const requireOwnedStaticFixtureInventory = (
  owner: object,
  operation: string,
): OwnedStaticFixtureInventoryToken => {
  const scope = scopes.getStore();
  if (
    scope === undefined ||
    scope.owner !== owner ||
    scope.operation !== operation
  )
    fail();
  return scope?.token ?? fail();
};
/** Only the policy's exact primary path can be opened; artifact scopes grant no general open. */
export const requireOwnedStaticFixtureOpen = (
  owner: object,
  path: string,
): OwnedStaticFixtureInventoryToken => {
  const scope = scopes.getStore();
  const binding = scope?.open_binding;
  if (
    scope === undefined ||
    scope.owner !== owner ||
    binding === undefined ||
    binding.primary_path !== path ||
    binding.input_digest !== scope.input_digest
  )
    fail();
  return scope?.token ?? fail();
};
const acquireWithinScope = async (
  scope: InventoryScope,
  path: string,
  kind: "file" | "directory" | "metadata",
): Promise<void> => {
  const bytes = inventoryFor(scope.token).bytes;
  if (scope.remainingAcquisitions === 0 || scope.remainingBytes < bytes) fail();
  --scope.remainingAcquisitions;
  scope.remainingBytes -= bytes;
  await admitOwnedStaticFixtureRead(scope.token, path, kind);
};
/** Verify the actual opened leaf before any descriptor bytes are consumed. */
const verifyDescriptor = (
  inventory: Inventory,
  path: string,
  metadata: OwnedStaticFixtureDescriptor,
): void => {
  const file = inventory.files.get(path);
  if (
    file === undefined ||
    !metadata.isFile() ||
    BigInt(metadata.dev) !== BigInt(file.dev) ||
    BigInt(metadata.ino) !== BigInt(file.ino) ||
    BigInt(metadata.size) !== BigInt(file.size) ||
    BigInt(metadata.nlink) !== 1n
  )
    fail();
};
