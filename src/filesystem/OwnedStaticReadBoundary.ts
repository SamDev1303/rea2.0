import { AsyncLocalStorage } from "node:async_hooks";
import type { FileHandle } from "node:fs/promises";
import { OwnedFileHandle } from "./OwnedFileHandle.js";
import {
  OwnedStaticFixtureCleanupFailure,
  withOwnedStaticFixtureResource,
} from "./OwnedStaticResource.js";

export interface OwnedStaticFixtureDescriptor {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly size: number | bigint;
  readonly nlink: number | bigint;
  isFile(): boolean;
}

/** Read mechanics installed by an admitted controller, never by target input. */
interface OwnedStaticReadMechanics {
  readonly retainCleanup?: (failure: OwnedStaticFixtureCleanupFailure) => void;
  readonly acquire: (
    path: string,
    kind: "file" | "directory" | "metadata",
  ) => Promise<void>;
  readonly descriptor: (
    path: string,
    metadata: OwnedStaticFixtureDescriptor,
  ) => void;
}

const boundaries = new AsyncLocalStorage<OwnedStaticReadMechanics>();

/** Keep policy selection in the caller; readers depend only on scoped mechanics. */
export const withOwnedStaticReadBoundary = <T>(
  mechanics: OwnedStaticReadMechanics,
  run: () => T,
): T =>
  boundaries.run(
    Object.freeze({
      ...(mechanics.retainCleanup === undefined
        ? {}
        : { retainCleanup: mechanics.retainCleanup }),
      acquire: mechanics.acquire,
      descriptor: mechanics.descriptor,
    }),
    run,
  );

/** Existing unscoped readers retain their own checks; this grants no operation. */
export const assertOwnedStaticFixtureAcquisition = async (
  path: string,
  kind: "file" | "directory" | "metadata",
): Promise<void> => {
  const boundary = boundaries.getStore();
  if (boundary !== undefined) await boundary.acquire(path, kind);
};

/** Check the actual leaf descriptor before its consumer can read bytes. */
export const assertOwnedStaticFixtureDescriptor = (
  path: string,
  metadata: OwnedStaticFixtureDescriptor,
): void => {
  boundaries.getStore()?.descriptor(path, metadata);
};

/** Scoped retention is lifecycle ownership only and confers no acquisition permission. */
export const retainOwnedStaticFixtureCleanup = (
  failure: OwnedStaticFixtureCleanupFailure,
): boolean => {
  const retain = boundaries.getStore()?.retainCleanup;
  if (retain === undefined) return false;
  retain(failure);
  return true;
};
/** Preserve a parser's primary failure and exact descriptor owner when close fails. */
export const withOwnedStaticFixtureFile = async <T>(
  handle: FileHandle,
  consume: () => Promise<T>,
): Promise<T> => {
  const boundary = boundaries.getStore();
  try {
    return await withOwnedStaticFixtureResource(
      { kind: "file", owner: new OwnedFileHandle(handle), scope: "parser" },
      consume,
    );
  } catch (cause: unknown) {
    if (cause instanceof OwnedStaticFixtureCleanupFailure)
      boundary?.retainCleanup?.(cause);
    throw cause;
  }
};
