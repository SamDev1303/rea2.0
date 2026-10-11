import {
  lstat,
  mkdtemp,
  open,
  rmdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { EvidenceFileError } from "../domain/evidenceErrors.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";

const pending = new Set<JsonWriteResources>();
const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

type JsonWriteOutcome<T = unknown> =
  | { readonly kind: "completed"; readonly value: T }
  | { readonly kind: "failed"; readonly cause: unknown };
interface JsonWritePublication {
  readonly path: string;
  readonly bytes: number;
  readonly state: "attempted" | "published";
}

/** An atomic write cannot discard an unresolved descriptor or staging directory. */
export class JsonWriteCleanupFailure extends EvidenceFileError {
  readonly #resources: JsonWriteResources;
  override readonly userMessage: string;
  get outcome(): JsonWriteOutcome | undefined {
    return this.#resources.outcome;
  }
  get publication(): JsonWritePublication | undefined {
    return this.#resources.publication;
  }
  get resources(): JsonWriteResources {
    return this.#resources;
  }
  constructor(
    resources: JsonWriteResources,
    primary: unknown,
    cleanup: unknown,
  ) {
    const options = {
      path: resources.destination,
      cause: new AggregateError(
        primary === undefined ? [cleanup] : [primary, cleanup],
        "Evidence write and cleanup outcomes",
      ),
      cleanup: { reason: message(cleanup), resources: [resources.directory] },
    };
    super("write", "io", options);
    this.#resources = resources;
    resources.retainPrimaryFailure(primary);
    const publication = resources.publication;
    this.userMessage =
      publication?.state === "published"
        ? `Evidence file was published at ${publication.path} (${publication.bytes} bytes); staging cleanup remains incomplete.`
        : "Evidence write cleanup remains incomplete; the exact operation outcome and owner are retained.";
  }
}

/** Private staging owner; cleanup uses only the recorded file and directory identities. */
export class JsonWriteResources {
  #directoryIdentity: { dev: number; ino: number } | undefined;
  #file: OwnedFileHandle | undefined;
  #fileIdentity: { dev: number; ino: number } | undefined;
  #closing: Promise<void> | undefined;
  #closed = false;
  #outcome: JsonWriteOutcome | undefined;
  #publication: JsonWritePublication | undefined;
  #primaryFailure: unknown;
  readonly #cleanupAttempts: unknown[] = [];
  get outcome(): JsonWriteOutcome | undefined {
    return this.#outcome;
  }
  retainOutcome(outcome: JsonWriteOutcome): void {
    this.#outcome ??= outcome;
  }
  get publication(): JsonWritePublication | undefined {
    return this.#publication === undefined
      ? undefined
      : { ...this.#publication };
  }
  preparePublication(bytes: number): void {
    this.#publication = { path: this.destination, bytes, state: "attempted" };
  }
  confirmPublication(): void {
    if (!this.#publication) throw new Error("Publication attempt missing");
    this.#publication = { ...this.#publication, state: "published" };
  }
  get primaryFailure(): unknown {
    return this.#primaryFailure;
  }
  get cleanupAttempts(): readonly unknown[] {
    return [...this.#cleanupAttempts];
  }
  retainPrimaryFailure(primary: unknown): void {
    if (this.#primaryFailure === undefined) this.#primaryFailure = primary;
    this.#outcome ??= { kind: "failed", cause: primary };
  }
  readonly #directory: string;
  readonly #destination: string;
  private constructor(directory: string, destination: string) {
    this.#directory = directory;
    this.#destination = destination;
  }
  get destination(): string {
    return this.#destination;
  }
  get directory(): string {
    return this.#directory;
  }
  static async create(destination: string): Promise<JsonWriteResources> {
    const directory = await mkdtemp(
      resolve(dirname(destination), ".rea-write-"),
    );
    const resources = new JsonWriteResources(directory, destination);
    try {
      resources.#directoryIdentity = await lstat(directory);
    } catch (primary: unknown) {
      pending.add(resources);
      throw new JsonWriteCleanupFailure(
        resources,
        primary,
        new Error(
          "Staging directory identity was not acquired; automatic removal is unavailable",
        ),
      );
    }
    return resources;
  }
  get staged(): string {
    return resolve(this.directory, "content");
  }
  async acquire(): Promise<FileHandle> {
    if (this.#file !== undefined || this.#closed)
      throw new Error("Staging file already acquired or closed");
    this.#file = new OwnedFileHandle(await open(this.staged, "wx", 0o600));
    this.#fileIdentity = await this.#file.handle.stat();
    return this.#file.handle;
  }
  async closeFile(): Promise<void> {
    await this.#file?.close();
  }
  close(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closing !== undefined) return this.#closing;
    this.#closing = this.#cleanup().finally(() => {
      this.#closing = undefined;
    });
    return this.#closing;
  }
  async #cleanup(): Promise<void> {
    try {
      await this.closeFile();
      if (this.#directoryIdentity === undefined)
        throw new Error("Staging directory identity remains unconfirmed");
      const directory = await lstat(this.directory);
      if (
        !directory.isDirectory() ||
        directory.isSymbolicLink() ||
        directory.dev !== this.#directoryIdentity.dev ||
        directory.ino !== this.#directoryIdentity.ino
      )
        throw new Error("Evidence staging directory identity changed");
      const staged = await lstat(this.staged).catch((cause: unknown) => {
        if (
          typeof cause === "object" &&
          cause !== null &&
          "code" in cause &&
          cause.code === "ENOENT"
        )
          return undefined;
        throw cause;
      });
      if (staged !== undefined) {
        if (
          this.#fileIdentity === undefined ||
          !staged.isFile() ||
          staged.isSymbolicLink() ||
          staged.dev !== this.#fileIdentity.dev ||
          staged.ino !== this.#fileIdentity.ino
        )
          throw new Error("Evidence staging file identity changed");
        await unlink(this.staged);
      }
      // Unknown descendants are never recursively deleted; rmdir fails and retains ownership.
      await rmdir(this.directory);
      this.#closed = true;
      pending.delete(this);
    } catch (cause: unknown) {
      this.#cleanupAttempts.push(cause);
      pending.add(this);
      throw cause;
    }
  }
}

/** Cleanup must complete before a failed write can be treated as released. */
export async function withJsonWriteResources<T>(
  destination: string,
  operation: (resources: JsonWriteResources) => Promise<T>,
): Promise<T> {
  const resources = await JsonWriteResources.create(destination);
  let value: T | undefined;
  let primary: unknown;
  let failed = false;
  try {
    value = await operation(resources);
  } catch (cause: unknown) {
    failed = true;
    primary = cause;
  }
  resources.retainOutcome(
    failed ? { kind: "failed", cause: primary } : { kind: "completed", value },
  );
  try {
    await resources.close();
  } catch (cleanup: unknown) {
    throw new JsonWriteCleanupFailure(
      resources,
      failed ? primary : undefined,
      cleanup,
    );
  }
  if (failed) throw primary;
  return value as T;
}

/** Explicit service shutdown retry retains unsuccessful staging owners. */
export const retryPendingJsonWriteCleanup = async (): Promise<void> => {
  const outcomes = await Promise.allSettled(
    [...pending].map(async (owner) => {
      try {
        await owner.close();
      } catch (cleanup: unknown) {
        throw new JsonWriteCleanupFailure(
          owner,
          owner.primaryFailure,
          new AggregateError(
            [...owner.cleanupAttempts, cleanup],
            "Evidence write cleanup retry causes",
          ),
        );
      }
    }),
  );
  const failures = outcomes.flatMap((value) =>
    value.status === "rejected" ? [value.reason as unknown] : [],
  );
  if (failures.length)
    throw new AggregateError(
      failures,
      "Evidence write cleanup remains incomplete",
    );
};
