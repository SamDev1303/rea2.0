import { isAbsolute, resolve } from "node:path";
import { ownedFixtureUnavailable } from "./OwnedFixturePolicyData.js";
import type { OwnedStaticFixtureOpenBinding } from "./OwnedStaticFixtureInventory.js";

export const validateOwnedStaticFixtureOpenBinding = (
  inventory: {
    readonly files: ReadonlyMap<string, unknown>;
    readonly directories: ReadonlyMap<string, unknown>;
  },
  operation: string,
  selected: {
    readonly input_digest?: string;
    readonly open_binding?: OwnedStaticFixtureOpenBinding;
  },
): OwnedStaticFixtureOpenBinding | undefined => {
  if (
    selected.input_digest !== undefined &&
    !/^[a-f0-9]{64}$/u.test(selected.input_digest)
  )
    throw ownedFixtureUnavailable("owned_static_fixture");
  const binding = selected.open_binding;
  if (binding === undefined) return undefined;
  if (
    binding.input_digest !== selected.input_digest ||
    !isAbsolute(binding.primary_path) ||
    resolve(binding.primary_path) !== binding.primary_path ||
    (!inventory.files.has(binding.primary_path) &&
      !inventory.directories.has(binding.primary_path)) ||
    binding.kind !== (operation === "open_binary" ? "direct-open" : "cli-stage")
  )
    throw ownedFixtureUnavailable("owned_static_fixture");
  return Object.freeze({
    primary_path: binding.primary_path,
    input_digest: binding.input_digest,
    kind: binding.kind,
  });
};
