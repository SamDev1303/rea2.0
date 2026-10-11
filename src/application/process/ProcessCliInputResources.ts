import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import type { AnalysisCleanupObservation } from "../../domain/analysisErrorBase.js";
import {
  RegularFileCleanupFailure,
  retryRegularFileCleanup,
} from "../RegularFileRead.js";

// Failed default callers retain their actual scope until an explicit cleanup attempt.
const pending = new Set<ProcessCliInputResources>();
const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** An unresolved input lease remains an exception, never a string-only CLI result. */
export class ProcessCliInputCleanupFailure extends AnalysisInputError {
  override readonly userMessage: string;
  readonly #inputFailure: RegularFileCleanupFailure;
  readonly #resources: ProcessCliInputResources;
  get inputFailure(): RegularFileCleanupFailure {
    return this.#inputFailure;
  }
  get resources(): ProcessCliInputResources {
    return this.#resources;
  }
  constructor(
    inputFailure: RegularFileCleanupFailure,
    resources: ProcessCliInputResources,
    cleanup: AnalysisCleanupObservation | undefined,
    failures: readonly RegularFileCleanupFailure[] = [inputFailure],
  ) {
    const outcome = inputFailure.outcome;
    const primary =
      outcome.kind === "failed"
        ? outcome.cause
        : typeof outcome.value === "object" &&
            outcome.value !== null &&
            "ok" in outcome.value &&
            outcome.value.ok === false &&
            "error" in outcome.value
          ? outcome.value.error
          : inputFailure.cleanupCause;
    const reason = message(primary);
    super(
      "process_input",
      {
        cause: new AggregateError(
          [
            primary,
            ...failures.flatMap((failure) =>
              failure === inputFailure
                ? failure.cleanupAttempts
                : [failure, ...failure.cleanupAttempts],
            ),
          ],
          "Process input and descriptor cleanup outcomes",
        ),
        ...(cleanup === undefined ? {} : { cleanup }),
      },
      primary instanceof AnalysisInputError ? primary.issues : [],
    );
    this.#inputFailure = inputFailure;
    this.#resources = resources;
    this.userMessage = `Process input could not be safely released at ${inputFailure.path}: ${reason}. Descriptor close failed: ${message(inputFailure.cleanupCause)}.${cleanup === undefined ? " Cleanup was subsequently confirmed; no target was dispatched." : " Cleanup remains incomplete; the exact owner is retained for explicit close."}`;
  }
}

/** Caller-owned input lifecycle, established before any scenario/evidence acquisition. */
export class ProcessCliInputResources {
  readonly #scope = new ArtifactResourceScope();
  #failures: RegularFileCleanupFailure[] = [];

  run<T>(read: () => Promise<T>): Promise<T> {
    return this.#scope.run(async () => {
      try {
        return await read();
      } catch (cause: unknown) {
        if (!(cause instanceof RegularFileCleanupFailure)) throw cause;
        const retry = await retryRegularFileCleanup(cause, this.#scope);
        if (retry.cleanup !== undefined) {
          this.#failures.push(cause);
          pending.add(this);
        }
        // Even a confirmed retry reports the original read/close failure and stops dispatch.
        throw new ProcessCliInputCleanupFailure(cause, this, retry.cleanup);
      }
    });
  }

  /** Wait for admitted reads, retry exact retained owners, and reject later reads. */
  async close(): Promise<void> {
    try {
      await this.#scope.close();
      pending.delete(this);
      this.#failures = [];
    } catch (cause: unknown) {
      const failure = this.#failures[0];
      if (failure === undefined) throw cause;
      failure.retainCleanupAttempt(cause);
      throw new ProcessCliInputCleanupFailure(
        failure,
        this,
        {
          reason: message(cause),
          resources: [
            ...new Set(this.#failures.map((failure) => failure.path)),
          ],
        },
        this.#failures,
      );
    }
  }
}

/** Explicit shutdown recovery for service callers that did not supply their own scope. */
export const retryPendingProcessCliInputCleanup = async (): Promise<void> => {
  const outcomes = await Promise.allSettled(
    [...pending].map((scope) => scope.close()),
  );
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason as unknown] : [],
  );
  if (failures.length > 0)
    throw new AggregateError(
      failures,
      "Process CLI input cleanup remains incomplete",
    );
};
