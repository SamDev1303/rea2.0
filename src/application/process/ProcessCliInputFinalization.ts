import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import {
  ProcessCliInputResources,
  ProcessCliInputCleanupFailure,
} from "./ProcessCliInputResources.js";

const pending = new Map<
  ProcessCliInputResources,
  { outcome: ProcessCliOutcome<unknown>; causes: unknown[] }
>();

export type ProcessCliOutcome<T> =
  | { readonly kind: "completed"; readonly value: T }
  | { readonly kind: "failed"; readonly cause: unknown };

/** Input shutdown retains the exact original return/throw and its cleanup owner. */
export class ProcessCliInputFinalizationFailure extends AnalysisInputError {
  readonly #resources: ProcessCliInputResources;
  readonly #outcome: ProcessCliOutcome<unknown>;
  get resources(): ProcessCliInputResources {
    return this.#resources;
  }
  get outcome(): ProcessCliOutcome<unknown> {
    return this.#outcome;
  }
  override readonly userMessage: string;
  constructor(
    resources: ProcessCliInputResources,
    outcome: ProcessCliOutcome<unknown>,
    cleanup: unknown,
  ) {
    super("process_input_shutdown", {
      cause: new AggregateError(
        outcome.kind === "failed" ? [outcome.cause, cleanup] : [cleanup],
        "Process CLI outcome and input shutdown failure",
      ),
      cleanup: {
        reason: cleanup instanceof Error ? cleanup.message : String(cleanup),
        resources: ["process_cli_input_scope"],
      },
    });
    this.#resources = resources;
    this.#outcome = outcome;
    this.userMessage =
      "Process input shutdown remains incomplete; the original operation outcome and exact scope are retained.";
  }
}

/** Settle shutdown explicitly; a later close never overwrites the operation outcome. */
export async function withProcessCliInputResources<T>(
  operation: (resources: ProcessCliInputResources) => Promise<T>,
  supplied?: ProcessCliInputResources,
): Promise<T> {
  const resources = supplied ?? new ProcessCliInputResources();
  const outcome: ProcessCliOutcome<T> = await operation(resources).then(
    (value) => ({ kind: "completed", value }) as const,
    (cause: unknown) => ({ kind: "failed", cause }) as const,
  );
  const retainedInput =
    outcome.kind === "failed" &&
    outcome.cause instanceof ProcessCliInputCleanupFailure &&
    outcome.cause.cleanupIncomplete;
  if (supplied === undefined && !retainedInput) {
    try {
      await resources.close();
    } catch (cleanup: unknown) {
      pending.set(resources, { outcome, causes: [cleanup] });
      throw new ProcessCliInputFinalizationFailure(resources, outcome, cleanup);
    }
  }
  if (outcome.kind === "failed") throw outcome.cause;
  return outcome.value;
}

/** Explicit retry for default callers whose final input shutdown was unresolved. */
export async function retryPendingProcessCliInputFinalization(): Promise<void> {
  const outcomes = await Promise.allSettled(
    [...pending].map(async ([resources, retained]) => {
      try {
        await resources.close();
        pending.delete(resources);
      } catch (cleanup: unknown) {
        retained.causes.push(cleanup);
        throw new ProcessCliInputFinalizationFailure(
          resources,
          retained.outcome,
          new AggregateError(
            [...retained.causes],
            "Input shutdown attempt causes",
          ),
        );
      }
    }),
  );
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason as unknown] : [],
  );
  if (failures.length)
    throw new AggregateError(
      failures,
      "Process CLI input finalization remains incomplete",
    );
}
