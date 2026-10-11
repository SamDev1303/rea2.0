import { isOwnedAppleStaticSession } from "../binary/OwnedAppleStaticSession.js";
import {
  ownedFixtureUnavailable,
  type OwnedFixturePolicyData,
} from "./OwnedFixturePolicyData.js";
import {
  assertOwnedStaticFixturePrimaryPath,
  type OwnedStaticFixtureInventoryToken,
  type OwnedStaticFixtureOpenBinding,
} from "./OwnedStaticFixtureInventory.js";

export const validateStaticProfile = (
  data: OwnedFixturePolicyData,
  staticPorts: ReadonlyMap<string, object>,
): void => {
  const hasStatic = data.grants.some((grant) => grant.mode === "owned-static");
  // No mixed execution profile: the static constructor has no environment or runtime providers.
  if (
    hasStatic &&
    (data.grants.some((grant) => grant.mode !== "owned-static") ||
      data.static_inventory === undefined ||
      data.environment.length !== 0 ||
      data.endpoints.length !== 0 ||
      data.files.some((file) => file.role !== "dependency"))
  )
    throw ownedFixtureUnavailable("owned_fixture");
  if (
    !hasStatic &&
    (data.static_inventory !== undefined || staticPorts.size !== 0)
  )
    throw ownedFixtureUnavailable("owned_fixture");
};
export const validateStaticGrant = (
  operation: string,
  portId: string | undefined,
  staticPorts: ReadonlyMap<string, object>,
): void => {
  const port = portId === undefined ? undefined : staticPorts.get(portId);
  if (
    ![
      "open_binary",
      "decode_interface_builder",
      "inspect_keyed_archive",
      "trace_dylib_resolution",
    ].includes(operation) ||
    port === undefined ||
    !isOwnedAppleStaticSession(port)
  )
    throw ownedFixtureUnavailable(operation);
};
export const staticOpenAuthority = (
  operation: string,
  snapshot: unknown,
  inputDigest: string,
): { readonly static_open_binding?: OwnedStaticFixtureOpenBinding } => {
  if (
    typeof snapshot !== "object" ||
    snapshot === null ||
    Array.isArray(snapshot)
  )
    throw ownedFixtureUnavailable(operation);
  const input = snapshot as Record<string, unknown>;
  if (operation === "open_binary") {
    if (
      typeof input.path !== "string" ||
      Object.keys(input).some((key) => key !== "path")
    )
      throw ownedFixtureUnavailable(operation);
    return {
      static_open_binding: Object.freeze({
        primary_path: input.path,
        input_digest: inputDigest,
        kind: "direct-open",
      }),
    };
  }
  if (!Object.hasOwn(input, "args")) return {};
  const args = input.args;
  if (
    typeof args !== "object" ||
    args === null ||
    Array.isArray(args) ||
    typeof (args as Record<string, unknown>).path !== "string" ||
    typeof input.options !== "object" ||
    input.options === null ||
    Array.isArray(input.options)
  )
    throw ownedFixtureUnavailable(operation);
  // Reject auxiliary acquisition selectors before a launcher can read them.
  const options = input.options as Record<string, unknown>;
  if (
    ["snapshot", "provider", "target-format"].some((key) =>
      Object.hasOwn(options, key),
    )
  )
    throw ownedFixtureUnavailable(operation);
  return {
    static_open_binding: Object.freeze({
      primary_path: (args as { path: string }).path,
      input_digest: inputDigest,
      kind: "cli-stage",
    }),
  };
};

export const prepareStaticFixtureAuthority = (selected: {
  readonly mode: string;
  readonly operation: string;
  readonly snapshot: unknown;
  readonly inputDigest: string;
  readonly inventory: OwnedStaticFixtureInventoryToken | undefined;
}): { readonly static_open_binding?: OwnedStaticFixtureOpenBinding } => {
  if (selected.mode !== "owned-static") return {};
  const authority = staticOpenAuthority(
    selected.operation,
    selected.snapshot,
    selected.inputDigest,
  );
  const binding = authority.static_open_binding;
  if (binding !== undefined) {
    if (selected.inventory === undefined)
      throw ownedFixtureUnavailable(selected.operation);
    assertOwnedStaticFixturePrimaryPath(
      selected.inventory,
      binding.primary_path,
    );
  }
  return authority;
};
export const assertOwnedFixtureMatchedPort = (
  operation: string,
  selected: {
    readonly mode: string;
    readonly portId: string | undefined;
    readonly ports: ReadonlyMap<string, object>;
    readonly actualPort: object | undefined;
    readonly selectedPort: object | undefined;
  },
): void => {
  if (selected.mode === "owned-files") return;
  if (
    selected.portId === undefined ||
    selected.actualPort === undefined ||
    selected.ports.get(selected.portId) !== selected.actualPort ||
    (selected.selectedPort !== undefined &&
      selected.selectedPort !== selected.actualPort)
  )
    throw ownedFixtureUnavailable(operation);
};
