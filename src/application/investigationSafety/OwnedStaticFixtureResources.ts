import { AnalysisCapabilityUnavailableError } from "../../domain/analysisErrorCore.js";
import { OwnedDirectoryHandle } from "../../filesystem/OwnedDirectoryHandle.js";
import { OwnedFileHandle } from "../../filesystem/OwnedFileHandle.js";
import {
  OwnedStaticFixtureCleanupFailure,
  type OwnedStaticResource as Resource,
  type OwnedStaticReaderOwner,
} from "../../filesystem/OwnedStaticResource.js";
export {
  OwnedStaticFixtureCleanupFailure,
  withOwnedStaticFixtureResource,
} from "../../filesystem/OwnedStaticResource.js";

/** An inventory retains ownership independently of an operation's serialized error. */
export class OwnedStaticFixtureResourceBank {
  readonly #pending = new Map<
    OwnedFileHandle | OwnedDirectoryHandle | OwnedStaticReaderOwner,
    {
      readonly resource: Resource;
      readonly failure: OwnedStaticFixtureCleanupFailure;
    }
  >();
  #retry: Promise<void> | undefined;
  retain(failure: OwnedStaticFixtureCleanupFailure): void {
    const file = failure.retainedOwnedFile;
    const directory = failure.retainedOwnedDirectory;
    const reader = failure.retainedOwnedReader;
    const resource: Resource =
      file !== undefined
        ? { kind: "file", owner: file }
        : directory !== undefined
          ? { kind: "directory", owner: directory }
          : reader !== undefined
            ? { kind: "reader", owner: reader, scope: "parser" }
            : (() => {
                throw failure;
              })();
    this.#pending.set(resource.owner, { resource, failure });
  }
  get pendingCount(): number {
    return this.#pending.size;
  }
  assertReady(): void {
    const pending = this.#pending.values().next();
    if (!pending.done) throw pending.value.failure;
  }
  /** Cache the in-flight retry so overlapping close paths do not issue duplicate closes. */
  retry(): Promise<void> {
    if (this.#retry !== undefined) return this.#retry;
    const attempt = Promise.resolve().then(async () => {
      const failures: unknown[] = [];
      const retained = Array.from(this.#pending);
      for (const [owner, entry] of retained) {
        try {
          await owner.close();
          this.#pending.delete(owner);
        } catch (cause: unknown) {
          failures.push(entry.failure, cause);
        }
      }
      if (this.#pending.size > 0) {
        throw new AnalysisCapabilityUnavailableError(
          "rea2-owned-fixture",
          "owned_static_fixture",
          "Retained inventory resource cleanup remains incomplete.",
          {
            cause: new AggregateError(
              failures,
              "Retained resource cleanup failed",
            ),
            cleanup: {
              reason:
                "Explicit cleanup could not confirm release of every retained resource.",
              resources: [
                ...new Set(
                  [...this.#pending.values()].flatMap(
                    ({ failure }) => failure.cleanupResources,
                  ),
                ),
              ],
            },
          },
        );
      }
    });
    this.#retry = attempt.finally(() => {
      this.#retry = undefined;
    });
    return this.#retry;
  }
}
