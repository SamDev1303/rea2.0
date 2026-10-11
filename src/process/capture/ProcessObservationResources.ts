import type { Dir } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { OwnedDirectoryHandle } from "../../filesystem/OwnedDirectoryHandle.js";
import { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";
import {
  describeProcessCaptureExecutionFailure,
  ProcessCaptureError,
} from "./ProcessCaptureError.js";

export type ProcessObservationOutcome<T> =
  | { readonly kind: "completed"; readonly value: T }
  | { readonly kind: "failed"; readonly cause: unknown };

type ObservationResource =
  | {
      readonly path: string;
      readonly kind: "file";
      readonly owner: OwnedFileHandle;
    }
  | {
      readonly path: string;
      readonly kind: "directory";
      readonly owner: OwnedDirectoryHandle;
    };

/** Keep the failed lease and both causes even after a transport projects the error. */
export class ProcessObservationCleanupFailure extends ProcessCaptureError {
  readonly #resource: ObservationResource;
  readonly #resources: ProcessObservationResources;
  readonly #outcome: ProcessObservationOutcome<unknown>;
  readonly #cleanupCause: unknown;
  constructor(
    resource: ObservationResource,
    resources: ProcessObservationResources,
    outcome: ProcessObservationOutcome<unknown>,
    cleanupCause: unknown,
  ) {
    const primary = outcome.kind === "failed" ? outcome.cause : cleanupCause;
    super("Process filesystem observation cleanup remains incomplete.", {
      reason: "cleanup_incomplete",
      cause: primary,
      cleanupResources: [resource.path],
      executionFailure:
        describeProcessCaptureExecutionFailure(primary) ??
        "Process filesystem observation failed.",
    });
    this.#resource = resource;
    this.#resources = resources;
    this.#outcome = outcome;
    this.#cleanupCause = cleanupCause;
  }
  get resources(): ProcessObservationResources {
    return this.#resources;
  }
  get primaryOutcome(): ProcessObservationOutcome<unknown> {
    return this.#outcome;
  }
  get cleanupCause(): unknown {
    return this.#cleanupCause;
  }
  get retainedOwnedFile(): OwnedFileHandle | undefined {
    return this.#resource.kind === "file" ? this.#resource.owner : undefined;
  }
  get retainedOwnedDirectory(): OwnedDirectoryHandle | undefined {
    return this.#resource.kind === "directory"
      ? this.#resource.owner
      : undefined;
  }
}

/** Capture-owned observation leases; cleanup never grants read or execution authority. */
export class ProcessObservationResources {
  readonly #pending = new Map<
    ObservationResource,
    ProcessObservationCleanupFailure
  >();
  readonly #active = new Set<Promise<unknown>>();
  #draining: Promise<void> | undefined;
  #closed = false;

  get pendingCount(): number {
    return this.#pending.size;
  }

  withFile<T>(
    path: string,
    handle: FileHandle,
    consume: () => Promise<T>,
  ): Promise<T> {
    return this.#with(
      { path, kind: "file", owner: new OwnedFileHandle(handle) },
      consume,
    );
  }
  withDirectory<T>(
    path: string,
    dir: Dir,
    consume: () => Promise<T>,
  ): Promise<T> {
    return this.#with(
      { path, kind: "directory", owner: new OwnedDirectoryHandle(dir) },
      consume,
    );
  }

  #with<T>(
    resource: ObservationResource,
    consume: () => Promise<T>,
  ): Promise<T> {
    // The caller has already acquired a handle. Even rejected admission must own and close it.
    const unavailable =
      this.#closed || this.#draining !== undefined || this.#pending.size > 0;
    const running = this.#consume(
      resource,
      unavailable
        ? async () => {
            throw new ProcessCaptureError(
              "Process observation resource scope is unavailable.",
            );
          }
        : consume,
    );
    this.#active.add(running);
    void running.then(
      () => {
        this.#active.delete(running);
      },
      () => {
        this.#active.delete(running);
      },
    );
    return running;
  }

  async #consume<T>(
    resource: ObservationResource,
    consume: () => Promise<T>,
  ): Promise<T> {
    let outcome: ProcessObservationOutcome<T>;
    try {
      outcome = { kind: "completed", value: await consume() };
    } catch (cause: unknown) {
      outcome = { kind: "failed", cause };
    }
    try {
      await resource.owner.close();
    } catch (cleanupCause: unknown) {
      const failure = new ProcessObservationCleanupFailure(
        resource,
        this,
        outcome,
        cleanupCause,
      );
      this.#pending.set(resource, failure);
      throw failure;
    }
    if (outcome.kind === "failed") throw outcome.cause;
    return outcome.value;
  }

  /** Retry only as an explicit lifecycle action, preserving the original operation failure. */
  retryCleanup(): Promise<void> {
    if (this.#draining !== undefined) return this.#draining;
    const attempt = this.#drain().finally(() => {
      this.#draining = undefined;
    });
    this.#draining = attempt;
    return attempt;
  }
  /** End observation admission and wait for active leases before retrying retained owners. */
  close(): Promise<void> {
    this.#closed = true;
    return this.retryCleanup();
  }
  async #drain(): Promise<void> {
    while (this.#active.size > 0) await Promise.allSettled(this.#active);
    const failures: ProcessObservationCleanupFailure[] = [];
    for (const [resource, prior] of this.#pending) {
      try {
        await resource.owner.close();
        this.#pending.delete(resource);
      } catch (cleanupCause: unknown) {
        const failure = new ProcessObservationCleanupFailure(
          resource,
          this,
          prior.primaryOutcome,
          cleanupCause,
        );
        this.#pending.set(resource, failure);
        failures.push(failure);
      }
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Process filesystem observation resources remain owned.",
      );
  }
}
