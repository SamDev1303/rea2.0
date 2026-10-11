import { ownedFixtureUnavailable } from "./OwnedFixturePolicyData.js";

export interface OwnedFixturePortBinding {
  readonly port_id: string;
  readonly reference: object;
}

/** Preserve controller object identity; this creates no handler authority itself. */
export const bindOwnedFixturePorts = (
  bindings: readonly OwnedFixturePortBinding[],
): ReadonlyMap<string, object> => {
  const ports = new Map<string, object>();
  for (const binding of bindings) {
    if (
      ports.has(binding.port_id) ||
      typeof binding.reference !== "object" ||
      binding.reference === null
    )
      throw ownedFixtureUnavailable("owned_fixture");
    ports.set(binding.port_id, binding.reference);
  }
  return ports;
};
