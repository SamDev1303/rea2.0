import { AnalysisCapabilityUnavailableError } from "../domain/analysisErrorCore.js";
import { OwnedDirectoryHandle } from "./OwnedDirectoryHandle.js";
import { OwnedFileHandle } from "./OwnedFileHandle.js";

/** A reader keeps ownership of its private descriptors without importing an upper layer. */
export interface OwnedStaticReaderOwner {
  close(): Promise<void>;
}

export type OwnedStaticResource =
  | {
      readonly kind: "file";
      readonly owner: OwnedFileHandle;
      readonly scope?: "parser";
    }
  | {
      readonly kind: "directory";
      readonly owner: OwnedDirectoryHandle;
      readonly scope?: "parser";
    }
  | {
      readonly kind: "reader";
      readonly owner: OwnedStaticReaderOwner;
      readonly scope: "parser";
    };
type Outcome<Value> =
  | { readonly kind: "completed"; readonly value: Value }
  | { readonly kind: "failed"; readonly cause: unknown };

/** Transfers the exact cleanup owner without exposing handles in JSON projections. */
export class OwnedStaticFixtureCleanupFailure extends AnalysisCapabilityUnavailableError {
  readonly #resource: OwnedStaticResource;
  readonly #cleanupCause: unknown;
  constructor(
    resource: OwnedStaticResource,
    primary: Outcome<unknown>,
    cleanupCause: unknown,
  ) {
    super(
      "rea2-owned-fixture",
      "owned_static_fixture",
      "Owned static fixture cleanup remains incomplete.",
      {
        cause: primary.kind === "failed" ? primary.cause : cleanupCause,
        cleanup: {
          reason:
            "Resource close was not confirmed; its original owner is retained.",
          resources: [
            `owned static ${resource.scope ?? "inventory"} ${resource.kind}`,
          ],
        },
      },
    );
    this.#resource = resource;
    this.#cleanupCause = cleanupCause;
  }
  get retainedOwnedFile(): OwnedFileHandle | undefined {
    return this.#resource.kind === "file" ? this.#resource.owner : undefined;
  }
  get retainedOwnedDirectory(): OwnedDirectoryHandle | undefined {
    return this.#resource.kind === "directory"
      ? this.#resource.owner
      : undefined;
  }
  get retainedOwnedReader(): OwnedStaticReaderOwner | undefined {
    return this.#resource.kind === "reader" ? this.#resource.owner : undefined;
  }
  get cleanupCause(): unknown {
    return this.#cleanupCause;
  }
}

/** Close once through the existing owner; never hide failure behind an automatic retry. */
export const withOwnedStaticFixtureResource = async <Value>(
  resource: OwnedStaticResource,
  consume: () => Promise<Value>,
): Promise<Value> => {
  let outcome: Outcome<Value>;
  try {
    outcome = { kind: "completed", value: await consume() };
  } catch (cause: unknown) {
    outcome = { kind: "failed", cause };
  }
  try {
    await resource.owner.close();
  } catch (cleanupCause: unknown) {
    throw new OwnedStaticFixtureCleanupFailure(resource, outcome, cleanupCause);
  }
  if (outcome.kind === "failed") throw outcome.cause;
  return outcome.value;
};
