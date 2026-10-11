import { expect, it } from "vitest";
import {
  withProcessCliInputResources,
  ProcessCliInputFinalizationFailure,
  retryPendingProcessCliInputFinalization,
} from "./ProcessCliInputFinalization.js";
import type { ProcessCliInputResources } from "./ProcessCliInputResources.js";

it.each(["completed", "failed"] as const)(
  "retains the exact %s outcome if default input shutdown fails",
  async (kind) => {
    const original =
      kind === "completed"
        ? {
            predicate_type: "rea.process-capture",
            normalized_result: { observed: "retained" },
          }
        : new Error("original capture exception");
    let resources: ProcessCliInputResources | undefined;
    let allowClose = false;
    let attempts = 0;
    try {
      const failure = await withProcessCliInputResources(async (scope) => {
        resources = scope;
        const close = scope.close.bind(scope);
        scope.close = async () => {
          attempts++;
          if (!allowClose) throw new Error("final input close blocked");
          await close();
        };
        if (kind === "failed") throw original;
        return original;
      }).catch((cause: unknown) => cause);
      expect(failure).toBeInstanceOf(ProcessCliInputFinalizationFailure);
      const retained = failure as ProcessCliInputFinalizationFailure;
      expect(retained.resources).toBe(resources);
      expect(retained.outcome).toEqual(
        kind === "completed"
          ? { kind, value: original }
          : { kind, cause: original },
      );
      expect((retained.cause as AggregateError).errors).toEqual(
        kind === "completed"
          ? [expect.objectContaining({ message: "final input close blocked" })]
          : [
              original,
              expect.objectContaining({ message: "final input close blocked" }),
            ],
      );
      expect(retained.cleanupIncomplete).toBe(true);
      expect(JSON.stringify(retained)).not.toContain("normalized_result");
      await expect(
        retryPendingProcessCliInputFinalization(),
      ).rejects.toBeInstanceOf(AggregateError);
    } finally {
      allowClose = true;
      await retryPendingProcessCliInputFinalization();
    }
    expect(attempts).toBe(3);
  },
);

it("retains original output and distinct failures across default input finalization retries", async () => {
  const original = { normalized_result: { retained: "completed" } };
  const failures = [
    new Error("initial"),
    new Error("retry1"),
    new Error("retry2"),
  ];
  let allowed = false;
  let index = 0;
  const tree = (v: unknown): unknown[] =>
    v instanceof AggregateError
      ? [v, ...v.errors.flatMap(tree)]
      : v instanceof Error && v.cause !== undefined
        ? [v, ...tree(v.cause)]
        : [v];
  try {
    const first = await withProcessCliInputResources(async (resources) => {
      const close = resources.close.bind(resources);
      resources.close = async () => {
        if (!allowed) throw failures[index++];
        await close();
      };
      return original;
    }).catch((cause: unknown) => cause);
    expect(first).toBeInstanceOf(ProcessCliInputFinalizationFailure);
    await retryPendingProcessCliInputFinalization().catch(() => {});
    const third = await retryPendingProcessCliInputFinalization().catch(
      (cause: unknown) => cause,
    );
    for (const failure of failures) expect(tree(third)).toContain(failure);
    const typed = tree(third).find(
      (x) => x instanceof ProcessCliInputFinalizationFailure,
    ) as ProcessCliInputFinalizationFailure;
    expect(typed.outcome).toEqual({ kind: "completed", value: original });
  } finally {
    allowed = true;
    await retryPendingProcessCliInputFinalization();
  }
});
