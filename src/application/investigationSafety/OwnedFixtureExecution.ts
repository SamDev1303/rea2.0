import { AsyncLocalStorage } from "node:async_hooks";
import type { OwnedFixtureAdmission } from "./OwnedFixturePolicy.js";
import { withBoundedOwnedStaticFixtureInventory } from "./OwnedStaticFixtureInventory.js";
import { ownedFixtureUnavailable } from "./OwnedFixturePolicyData.js";

const executions = new AsyncLocalStorage<OwnedFixtureAdmission>();

/** Carry controller-approved execution data across one admitted handler only. */
export const runOwnedFixtureExecution = <T>(
  admission: OwnedFixtureAdmission | undefined,
  run: () => T,
): T => {
  if (admission === undefined) return run();
  if (admission.mode !== "owned-static") return executions.run(admission, run);
  if (
    admission.static_inventory === undefined ||
    admission.static_owner === undefined ||
    admission.static_operation === undefined ||
    admission.static_input_digest === undefined
  )
    throw ownedFixtureUnavailable("owned_static_fixture");
  return executions.run(admission, () =>
    withBoundedOwnedStaticFixtureInventory(
      admission.static_inventory!,
      admission.static_owner!,
      admission.static_operation!,
      {
        run,
        input_digest: admission.static_input_digest!,
        ...(admission.static_open_binding === undefined
          ? {}
          : { open_binding: admission.static_open_binding }),
      },
    ),
  );
};

/** Runtime subprocesses use the sealed map, never the host's ambient secrets. */
export const ownedFixtureExecutionEnvironment = (
  _fallback?: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string | undefined>> =>
  executions.getStore()?.environment ?? Object.freeze({});
