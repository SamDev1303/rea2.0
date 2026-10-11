import { isAbsolute, resolve } from "node:path";
import {
  bindOwnedFixturePorts,
  type OwnedFixturePortBinding,
} from "./OwnedFixturePortBindings.js";
export type { OwnedFixturePortBinding } from "./OwnedFixturePortBindings.js";
import { OwnedStaticFixtureCleanupFailure } from "./OwnedStaticFixtureResources.js";
import {
  validateStaticProfile,
  validateStaticGrant,
  prepareStaticFixtureAuthority,
  assertOwnedFixtureMatchedPort,
} from "./OwnedStaticFixtureAuthority.js";
import {
  sealOwnedStaticFixtureInventory,
  revalidateOwnedStaticFixtureInventory,
  type OwnedStaticFixtureInventoryToken,
  type OwnedStaticFixtureOpenBinding,
  retryOwnedStaticFixtureCleanup,
  ownedStaticFixturePendingCleanupCount,
} from "./OwnedStaticFixtureInventory.js";
import {
  identifyOwnedFixtureFile,
  verifyOwnedFixtureEndpointBindings,
  verifyOwnedProcessInput,
  identifyOwnedFixtureDirectory,
  verifyOwnedFixtureEnvironment,
  withinOwnedFixtureRoot,
  type OwnedFixtureFileIdentity,
  type OwnedFixtureRootIdentity,
  type OwnedFixtureEndpointBinding,
} from "./OwnedFixturePolicyRuntime.js";
export type { OwnedFixtureEndpointBinding } from "./OwnedFixturePolicyRuntime.js";
import {
  validateOwnedTimedFixtureGrant,
  digestOwnedFixtureInput,
  isKnownOwnedFixtureOperation,
  isNonexecutingOwnedFixtureOperation,
  isSupportedOwnedFixtureEnvironmentName,
  normalizeOwnedFixtureOperation,
  ownedFixtureUnavailable,
  parseOwnedFixturePolicy,
  snapshotOwnedFixtureInput,
  type OwnedFixturePolicyData,
} from "./OwnedFixturePolicyData.js";
export {
  digestOwnedFixtureInput,
  snapshotOwnedFixtureInput,
  type OwnedFixturePolicyData,
} from "./OwnedFixturePolicyData.js";
import { lstat, realpath } from "node:fs/promises";

import {
  admitInvestigationPath,
  admitInvestigationPaths,
} from "./InvestigationAdmission.js";

declare const tokenBrand: unique symbol;
export type OwnedFixturePolicyToken = { readonly [tokenBrand]: true };
interface SealedPolicy {
  readonly data: OwnedFixturePolicyData;
  readonly roots: readonly OwnedFixtureRootIdentity[];
  readonly files: readonly OwnedFixtureFileIdentity[];
  readonly ports: ReadonlyMap<string, object>;
  readonly staticPorts: ReadonlyMap<string, object>;
  readonly staticInventory: OwnedStaticFixtureInventoryToken | undefined;
  readonly environment: Readonly<Record<string, string>>;
  readonly endpointBindings: readonly OwnedFixtureEndpointBinding[];
  readonly directories: Map<string, OwnedFixtureRootIdentity>;
}
export interface OwnedFixtureAdmission {
  readonly mode: "owned-files" | "nonexecuting-stub" | "owned-static";
  readonly capability: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly endpoints: readonly string[];
  readonly static_inventory?: OwnedStaticFixtureInventoryToken;
  readonly static_owner?: object;
  readonly static_operation?: string;
  readonly static_input_digest?: string;
  readonly static_open_binding?: OwnedStaticFixtureOpenBinding;
}
const tokens = new WeakSet<object>();
const policies = new WeakMap<object, SealedPolicy>();
const owners = new WeakMap<
  object,
  {
    readonly token: OwnedFixturePolicyToken;
    readonly nonexecutingPort: object | undefined;
  }
>();
const handlerPorts = new WeakMap<object, object>();
const handlerEnvironments = new WeakMap<
  object,
  Readonly<Record<string, string>>
>();
/** Lifecycle-only retry; it never changes an earlier operation failure into success. */
export const retryOwnedFixtureCleanup = (instance: object): Promise<void> => {
  const owner = owners.get(instance);
  const inventory =
    owner === undefined
      ? undefined
      : policies.get(owner.token)?.staticInventory;
  return inventory === undefined
    ? Promise.resolve()
    : retryOwnedStaticFixtureCleanup(inventory);
};
export const ownedFixturePendingCleanupCount = (instance: object): number => {
  const owner = owners.get(instance);
  const inventory =
    owner === undefined
      ? undefined
      : policies.get(owner.token)?.staticInventory;
  return inventory === undefined
    ? 0
    : ownedStaticFixturePendingCleanupCount(inventory);
};

/** Factory-only registration captures the port actually closed over by handlers. */
export const registerOwnedFixtureHandlerPort = (
  owner: object,
  actualPort: object,
): void => {
  if (handlerPorts.has(owner) || owners.has(owner))
    throw ownedFixtureUnavailable("owned_fixture");
  handlerPorts.set(owner, actualPort);
};
export const getOwnedFixtureHandlerPort = (owner: object): object | undefined =>
  handlerPorts.get(owner);
/** Snapshot the selected factory environment; runtime consumers still use the sealed clean environment. */
export const registerOwnedFixtureHandlerEnvironment = (
  owner: object,
  environment: Readonly<Record<string, string | undefined>>,
): void => {
  if (handlerEnvironments.has(owner) || owners.has(owner))
    throw ownedFixtureUnavailable("owned_fixture");
  handlerEnvironments.set(
    owner,
    Object.freeze(
      Object.fromEntries(
        Object.entries(environment).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    ),
  );
};
const freezeData = (data: OwnedFixturePolicyData): void => {
  if (data.static_inventory !== undefined) {
    Object.freeze(data.static_inventory.directories);
    Object.freeze(data.static_inventory);
  }
  for (const collection of [data.files, data.environment, data.grants])
    for (const entry of collection) Object.freeze(entry);
  for (const collection of [
    data.roots,
    data.files,
    data.endpoints,
    data.environment,
    data.available_capabilities,
    data.grants,
  ])
    Object.freeze(collection);
  Object.freeze(data);
};

const identifyRoots = async (
  paths: readonly string[],
): Promise<readonly OwnedFixtureRootIdentity[]> => {
  const roots: OwnedFixtureRootIdentity[] = [];
  for (const path of paths) {
    await admitInvestigationPath("owned_fixture", path);
    const canonical = await realpath(path);
    const metadata = await lstat(path);
    if (
      !isAbsolute(path) ||
      canonical !== resolve(path) ||
      !metadata.isDirectory()
    )
      throw ownedFixtureUnavailable("owned_fixture");
    roots.push(
      Object.freeze({
        path: canonical,
        dev: metadata.dev,
        ino: metadata.ino,
      }),
    );
  }
  return Object.freeze(roots);
};
const identifyFiles = async (
  selectedFiles: OwnedFixturePolicyData["files"],
  roots: readonly OwnedFixtureRootIdentity[],
): Promise<readonly OwnedFixtureFileIdentity[]> => {
  const files: OwnedFixtureFileIdentity[] = [];
  let remainingBudget = 512 * 1024 * 1024;
  for (const file of selectedFiles) {
    if (
      file.role === "executable" &&
      file.path !== (await realpath(process.execPath))
    )
      throw ownedFixtureUnavailable("owned_fixture");
    if (files.some((existing) => existing.path === resolve(file.path)))
      throw ownedFixtureUnavailable("owned_fixture");
    if (
      file.role !== "executable" &&
      !roots.some((root) =>
        withinOwnedFixtureRoot(root.path, resolve(file.path)),
      )
    )
      throw ownedFixtureUnavailable("owned_fixture");
    const identified = await identifyOwnedFixtureFile(
      file.path,
      file.sha256,
      remainingBudget,
    );
    remainingBudget -= identified.bytes;
    files.push(identified);
  }
  return Object.freeze(files);
};
const validateGrants = (
  data: OwnedFixturePolicyData,
  ports: ReadonlyMap<string, object>,
  staticPorts: ReadonlyMap<string, object>,
): void => {
  validateStaticProfile(data, staticPorts);
  for (const grant of data.grants) {
    const operation = normalizeOwnedFixtureOperation(grant.operation);
    validateOwnedTimedFixtureGrant(data, grant);
    if (
      !isKnownOwnedFixtureOperation(operation) ||
      !data.available_capabilities.includes(grant.capability)
    )
      throw ownedFixtureUnavailable(operation);
    if (grant.mode === "owned-static") {
      validateStaticGrant(operation, grant.port_id, staticPorts);
    } else if (grant.mode === "nonexecuting-stub") {
      if (
        !isNonexecutingOwnedFixtureOperation(operation) ||
        grant.port_id === undefined ||
        !ports.has(grant.port_id)
      )
        throw ownedFixtureUnavailable(operation);
    } else if (
      !["capture_process", "capture_process_scenario"].includes(operation) ||
      grant.port_id !== undefined ||
      !data.files.some((file) => file.role === "executable")
    )
      throw ownedFixtureUnavailable(operation);
  }
};
const sealEnvironment = (
  entries: OwnedFixturePolicyData["environment"],
): Readonly<Record<string, string>> => {
  const environment: Record<string, string> = {};
  for (const item of entries) {
    if (
      !isSupportedOwnedFixtureEnvironmentName(item.name) ||
      /(?:TOKEN|SECRET|PASSWORD|KEY|AUTH|COOKIE|CREDENTIAL)/u.test(item.name) ||
      /^(?:NODE_|LD_|DYLD_|PYTHON|RUBY|PERL|BASH_ENV$|ENV$|SHELLOPTS$|BASHOPTS$|GCONV_PATH$|JAVA_TOOL_OPTIONS$|JDK_JAVA_OPTIONS$|_JAVA_OPTIONS$|NPM_CONFIG_|npm_config_)/u.test(
        item.name,
      ) ||
      Object.hasOwn(environment, item.name)
    )
      throw ownedFixtureUnavailable("owned_fixture");
    environment[item.name] = item.value;
  }
  return Object.freeze(environment);
};
/** Internal controller composition only; never exported by a public package entry or tool schema. */
export const sealOwnedFixturePolicy = async (
  value: unknown,
  bindings: {
    readonly nonexecuting_ports?: readonly OwnedFixturePortBinding[];
    readonly owned_static_ports?: readonly OwnedFixturePortBinding[];
    readonly loopback_endpoints?: readonly OwnedFixtureEndpointBinding[];
  } = {},
): Promise<OwnedFixturePolicyToken> => {
  try {
    const data = parseOwnedFixturePolicy(snapshotOwnedFixtureInput(value));
    const roots = await identifyRoots(data.roots);
    const staticPorts = bindOwnedFixturePorts(
      bindings.owned_static_ports ?? [],
    );
    const ports = bindOwnedFixturePorts(bindings.nonexecuting_ports ?? []);
    validateGrants(data, ports, staticPorts);
    const staticInventory =
      data.static_inventory === undefined
        ? undefined
        : await sealOwnedStaticFixtureInventory({
            roots: data.roots,
            directories: data.static_inventory.directories,
            files: data.files,
          });
    const files =
      staticInventory === undefined
        ? await identifyFiles(data.files, roots)
        : [];
    const endpointBindings = Object.freeze(
      (bindings.loopback_endpoints ?? []).map((binding) =>
        Object.freeze({ url: binding.url, server: binding.server }),
      ),
    );
    verifyOwnedFixtureEndpointBindings(data.endpoints, endpointBindings);
    const environment = sealEnvironment(data.environment);
    const directories = new Map<string, OwnedFixtureRootIdentity>();
    await verifyOwnedFixtureEnvironment({
      data,
      roots,
      files,
      environment,
      directories,
    });
    freezeData(data);
    const token = Object.freeze({}) as OwnedFixturePolicyToken;
    tokens.add(token);
    policies.set(token, {
      data,
      roots: Object.freeze(roots),
      files: Object.freeze(files),
      ports,
      staticPorts,
      staticInventory,
      environment: Object.freeze(environment),
      endpointBindings,
      directories,
    });
    return token;
  } catch (cause: unknown) {
    if (cause instanceof OwnedStaticFixtureCleanupFailure) throw cause;
    throw ownedFixtureUnavailable("owned_fixture");
  }
};
/** Bind only a branded controller token to an existing internal handler owner. */
export const attachOwnedFixturePolicy = (
  instance: object,
  token: OwnedFixturePolicyToken,
  actualNonexecutingPort?: object,
): void => {
  if (!tokens.has(token) || owners.has(instance))
    throw ownedFixtureUnavailable("owned_fixture");
  const policy = policies.get(token);
  if (policy === undefined) throw ownedFixtureUnavailable("owned_fixture");
  for (const grant of policy.data.grants)
    if (
      (grant.mode === "nonexecuting-stub" || grant.mode === "owned-static") &&
      (actualNonexecutingPort === undefined ||
        handlerPorts.get(instance) !== actualNonexecutingPort ||
        grant.port_id === undefined ||
        (grant.mode === "owned-static" ? policy.staticPorts : policy.ports).get(
          grant.port_id,
        ) !== actualNonexecutingPort)
    )
      throw ownedFixtureUnavailable("owned_fixture");
  if (
    policy.data.grants.some(
      (grant) => grant.mode === "owned-files" || grant.mode === "owned-static",
    )
  ) {
    const factoryEnvironment = handlerEnvironments.get(instance);
    if (
      factoryEnvironment === undefined ||
      Object.keys(factoryEnvironment).length !==
        Object.keys(policy.environment).length ||
      Object.entries(policy.environment).some(
        ([name, value]) => factoryEnvironment[name] !== value,
      )
    )
      throw ownedFixtureUnavailable("owned_fixture");
  }
  owners.set(
    instance,
    Object.freeze({ token, nonexecutingPort: actualNonexecutingPort }),
  );
};
/** Revalidate sealed bytes and identities immediately before each actual dispatch. */
export const revalidateOwnedFixturePolicy = async (
  instance: object,
): Promise<void> => {
  const owner = owners.get(instance);
  const policy = owner === undefined ? undefined : policies.get(owner.token);
  if (policy === undefined) throw ownedFixtureUnavailable("owned_fixture");
  try {
    if (policy.staticInventory !== undefined)
      await revalidateOwnedStaticFixtureInventory(policy.staticInventory);
    verifyOwnedFixtureEndpointBindings(
      policy.data.endpoints,
      policy.endpointBindings,
    );
    for (const root of policy.roots) {
      await admitInvestigationPath("owned_fixture", root.path);
      const current = await lstat(root.path);
      if (
        !current.isDirectory() ||
        current.dev !== root.dev ||
        current.ino !== root.ino ||
        (await realpath(root.path)) !== root.path
      )
        throw ownedFixtureUnavailable("owned_fixture");
    }
    for (const directory of policy.directories.values()) {
      const current = await identifyOwnedFixtureDirectory(directory.path);
      if (current.dev !== directory.dev || current.ino !== directory.ino)
        throw ownedFixtureUnavailable("owned_fixture");
    }
    for (const file of policy.files) {
      const current = await identifyOwnedFixtureFile(file.path, file.sha256);
      if (current.dev !== file.dev || current.ino !== file.ino)
        throw ownedFixtureUnavailable("owned_fixture");
    }
  } catch (cause: unknown) {
    if (cause instanceof OwnedStaticFixtureCleanupFailure) throw cause;
    throw ownedFixtureUnavailable("owned_fixture");
  }
};
/** Exact controller grants precede any path ingestion; unmatched requests confer no authority. */
export const admitOwnedFixtureOperation = async (
  instance: object,
  operation: string,
  input: unknown,
  selectedNonexecutingPort?: object,
): Promise<OwnedFixtureAdmission | undefined> => {
  const owner = owners.get(instance);
  const policy = owner === undefined ? undefined : policies.get(owner.token);
  if (policy === undefined) return undefined;
  const snapshot = snapshotOwnedFixtureInput(input);
  const inputDigest = digestOwnedFixtureInput(snapshot);
  const grant = policy.data.grants.find(
    (entry) =>
      normalizeOwnedFixtureOperation(entry.operation) ===
        normalizeOwnedFixtureOperation(operation) &&
      entry.input_digest === inputDigest,
  );
  if (grant === undefined) return undefined;
  const staticAuthority = prepareStaticFixtureAuthority({
    mode: grant.mode,
    operation: normalizeOwnedFixtureOperation(operation),
    snapshot,
    inputDigest,
    inventory: policy.staticInventory,
  });
  if (grant.mode !== "owned-static")
    await admitInvestigationPaths(operation, snapshot);
  if (!policy.data.available_capabilities.includes(grant.capability))
    throw ownedFixtureUnavailable(operation);
  assertOwnedFixtureMatchedPort(operation, {
    mode: grant.mode,
    portId: grant.port_id,
    ports: grant.mode === "owned-static" ? policy.staticPorts : policy.ports,
    actualPort: owner?.nonexecutingPort,
    selectedPort: selectedNonexecutingPort,
  });
  await revalidateOwnedFixturePolicy(instance);
  if (grant.mode === "owned-files") {
    try {
      await verifyOwnedProcessInput(policy, snapshot, grant.capability);
      await revalidateOwnedFixturePolicy(instance);
    } catch {
      throw ownedFixtureUnavailable(operation);
    }
  }
  return Object.freeze({
    mode: grant.mode,
    capability: grant.capability,
    environment: policy.environment,
    endpoints: policy.data.endpoints,
    ...(grant.mode === "owned-static" &&
    policy.staticInventory !== undefined &&
    owner?.nonexecutingPort !== undefined
      ? {
          static_inventory: policy.staticInventory,
          static_owner: owner.nonexecutingPort,
          static_operation: normalizeOwnedFixtureOperation(operation),
          static_input_digest: inputDigest,
          ...staticAuthority,
        }
      : {}),
  });
};
/** Scoped inventory only: exact grants never establish general host capability availability. */
export const listOwnedFixtureOperations = (
  instance: object,
): readonly {
  readonly operation: string;
  readonly input_digest: string;
  readonly capability: string;
  readonly mode: "owned-files" | "nonexecuting-stub" | "owned-static";
}[] => {
  const owner = owners.get(instance);
  const policy = owner === undefined ? undefined : policies.get(owner.token);
  return Object.freeze(
    (policy?.data.grants ?? []).map((grant) =>
      Object.freeze({
        operation: grant.operation,
        input_digest: grant.input_digest,
        capability: grant.capability,
        mode: grant.mode,
      }),
    ),
  );
};
