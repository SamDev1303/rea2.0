import { verifyOwnedNodeFixtureScript } from "./OwnedNodeFixtureProfile.js";
import { verifyOwnedTimedNodeFixtureScript } from "./OwnedTimedNodeFixtureProfile.js";
import {
  OWNED_TIMED_FIXTURE_CAPABILITY,
  OWNED_TIMED_FIXTURE_HEAP_ARGUMENT,
} from "./OwnedFixturePolicyData.js";
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { Server } from "node:net";
import {
  isAbsolute,
  resolve,
  sep,
  parse as parsePath,
  extname,
} from "node:path";
import {
  processScenarioSchema,
  type ProcessScenario,
} from "../../domain/process/processScenario.js";
import {
  openRegularFile,
  sameRegularFileState,
} from "../../filesystem/RegularFile.js";
import { readRegularFile } from "../RegularFileRead.js";
import {
  admitInvestigationPath,
  admitInvestigationPaths,
} from "./InvestigationAdmission.js";
import {
  digestOwnedFixtureInput,
  isSupportedOwnedFixtureEnvironmentName,
  ownedFixtureUnavailable,
  type OwnedFixturePolicyData,
} from "./OwnedFixturePolicyData.js";
export interface OwnedFixtureEndpointBinding {
  readonly url: string;
  readonly server: Server;
}
export interface OwnedFixtureFileIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly dev: number;
  readonly ino: number;
  readonly bytes: number;
}
export interface OwnedFixtureRootIdentity {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

export const withinOwnedFixtureRoot = (root: string, path: string): boolean =>
  path === root || path.startsWith(`${root}${sep}`);
export interface OwnedFixtureRuntimeScope {
  readonly data: Pick<OwnedFixturePolicyData, "files" | "endpoints">;
  readonly roots: readonly OwnedFixtureRootIdentity[];
  readonly files: readonly OwnedFixtureFileIdentity[];
  readonly environment: Readonly<Record<string, string>>;
  readonly directories: Map<string, OwnedFixtureRootIdentity>;
}
/** Canonical existing directory, including every ancestor; this is not a descriptor-relative spawn. */
export const identifyOwnedFixtureDirectory = async (
  path: string,
): Promise<OwnedFixtureRootIdentity> => {
  await admitInvestigationPath("owned_fixture", path);
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    (await realpath(path)) !== path
  )
    throw ownedFixtureUnavailable("owned_fixture");
  const root = parsePath(path).root;
  let component = root;
  for (const part of path.slice(root.length).split(sep).filter(Boolean)) {
    component = resolve(component, part);
    if (!(await lstat(component)).isDirectory())
      throw ownedFixtureUnavailable("owned_fixture");
  }
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || (await realpath(path)) !== path)
    throw ownedFixtureUnavailable("owned_fixture");
  return Object.freeze({ path, dev: metadata.dev, ino: metadata.ino });
};
const bindOwnedDirectory = async (
  policy: OwnedFixtureRuntimeScope,
  path: string,
): Promise<void> => {
  if (!policy.roots.some((root) => withinOwnedFixtureRoot(root.path, path)))
    throw ownedFixtureUnavailable("owned_fixture");
  const current = await identifyOwnedFixtureDirectory(path);
  const previous = policy.directories.get(path);
  if (
    previous !== undefined &&
    (previous.dev !== current.dev || previous.ino !== current.ino)
  )
    throw ownedFixtureUnavailable("owned_fixture");
  if (previous === undefined) {
    if (policy.directories.size >= 128)
      throw ownedFixtureUnavailable("owned_fixture");
    policy.directories.set(path, current);
  }
};
/** Validate the entire clean environment, including values omitted from scenario overrides. */
export const verifyOwnedFixtureEnvironment = async (
  policy: OwnedFixtureRuntimeScope,
): Promise<void> => {
  for (const [name, value] of Object.entries(policy.environment)) {
    if (
      !isSupportedOwnedFixtureEnvironmentName(name) ||
      hasControlCharacter(value)
    )
      throw ownedFixtureUnavailable("owned_fixture");
    if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) {
      if (!policy.data.endpoints.includes(value))
        throw ownedFixtureUnavailable("owned_fixture");
    } else if (isAbsolute(value)) {
      await bindOwnedDirectory(policy, value);
    } else if (
      /(?:HOME|DIR|PATH|URL|URI|ENDPOINT)$/u.test(name) ||
      !/^[A-Za-z0-9 _.,;=+-]*$/u.test(value)
    ) {
      throw ownedFixtureUnavailable("owned_fixture");
    }
  }
};
export const identifyOwnedFixtureFile = async (
  path: string,
  expected: string,
  remainingBudget = 256 * 1024 * 1024,
): Promise<OwnedFixtureFileIdentity> => {
  await admitInvestigationPath("owned_fixture", path);
  if (!isAbsolute(path) || (await realpath(path)) !== resolve(path))
    throw ownedFixtureUnavailable("owned_fixture");
  const handle = await openRegularFile(path, { symlinks: "reject" });
  try {
    const initial = await handle.stat();
    if (
      initial.nlink !== 1 ||
      initial.size > Math.min(remainingBudget, 256 * 1024 * 1024)
    )
      throw ownedFixtureUnavailable("owned_fixture");
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < initial.size) {
      const read = await handle.read(
        chunk,
        0,
        Math.min(chunk.length, initial.size - position),
        position,
      );
      if (read.bytesRead === 0) throw ownedFixtureUnavailable("owned_fixture");
      hash.update(chunk.subarray(0, read.bytesRead));
      position += read.bytesRead;
    }
    const [opened, named] = await Promise.all([handle.stat(), lstat(path)]);
    if (
      opened.nlink !== 1 ||
      named.nlink !== 1 ||
      !sameRegularFileState(initial, opened) ||
      !sameRegularFileState(initial, named) ||
      (await realpath(path)) !== resolve(path) ||
      hash.digest("hex") !== expected
    )
      throw ownedFixtureUnavailable("owned_fixture");
    return Object.freeze({
      path: resolve(path),
      sha256: expected,
      dev: initial.dev,
      ino: initial.ino,
      bytes: initial.size,
    });
  } finally {
    await handle.close();
  }
};
const endpoint = (value: string): string => {
  const url = new URL(value);
  if (
    !["http:", "ws:"].includes(url.protocol) ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.port === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.href !== value
  )
    throw ownedFixtureUnavailable("owned_fixture");
  return value;
};
export const verifyOwnedFixtureEndpointBindings = (
  urls: readonly string[],
  bindings: readonly OwnedFixtureEndpointBinding[],
): void => {
  if (bindings.length !== urls.length)
    throw ownedFixtureUnavailable("owned_fixture");
  for (const value of urls) {
    endpoint(value);
    const selected = bindings.filter((binding) => binding.url === value);
    if (selected.length !== 1) throw ownedFixtureUnavailable("owned_fixture");
    const server = selected[0]?.server;
    if (!(server instanceof Server) || !server.listening)
      throw ownedFixtureUnavailable("owned_fixture");
    const address = server.address();
    const url = new URL(value);
    if (
      address === null ||
      typeof address === "string" ||
      address.port !== Number(url.port) ||
      address.address !== url.hostname.replaceAll("[", "").replaceAll("]", "")
    )
      throw ownedFixtureUnavailable("owned_fixture");
  }
};
/** Only these schema fields select filesystem bytes; stdin and normalization are data. */
const verifyOwnedObservationFiles = async (
  policy: OwnedFixtureRuntimeScope,
  paths: readonly string[],
  workingDirectory: string,
): Promise<void> => {
  for (const value of paths) {
    if (
      hasControlCharacter(value) ||
      value.startsWith("~") ||
      /^[a-z][a-z0-9+.-]*:/iu.test(value)
    )
      throw ownedFixtureUnavailable("owned_fixture");
    const path = resolve(workingDirectory, value);
    if (!policy.roots.some((root) => withinOwnedFixtureRoot(root.path, path)))
      throw ownedFixtureUnavailable("owned_fixture");
    await admitInvestigationPath("owned_fixture", path);
    const seed = policy.files.find((file) => file.path === path);
    if (seed === undefined) throw ownedFixtureUnavailable("owned_fixture");
    // Directory recursion has no sealed descendant inventory or protected-file
    // mediation. This profile admits only explicit sealed regular files.
    const current = await lstat(path);
    if (
      !current.isFile() ||
      current.nlink !== 1 ||
      current.dev !== seed.dev ||
      current.ino !== seed.ino ||
      current.size !== seed.bytes ||
      (await realpath(path)) !== path
    )
      throw ownedFixtureUnavailable("owned_fixture");
  }
};

const validateTimedInteractions = (scenario: ProcessScenario): void => {
  if (scenario.events.length > 64)
    throw ownedFixtureUnavailable("owned_fixture");
  let totalBytes = 0;
  for (const event of scenario.events) {
    if (event.type !== "input") continue;
    const bytes = Buffer.byteLength(event.data, "utf8");
    if (bytes > 4096 || (totalBytes += bytes) > 65536)
      throw ownedFixtureUnavailable("owned_fixture");
  }
};
const validateTimedScenario = (
  policy: OwnedFixtureRuntimeScope,
  scenario: ProcessScenario,
): void => {
  if (
    Object.keys(policy.environment).length !== 0 ||
    policy.data.endpoints.length !== 0 ||
    Object.keys(scenario.environment).length !== 0 ||
    scenario.filesystem_observation_paths.length !== 0 ||
    scenario.timeout_ms > 15000 ||
    scenario.idle_timeout_ms > 15000 ||
    scenario.finalization_ms !== 0 ||
    scenario.settle_ms > 1000 ||
    scenario.limits.output_bytes > 1000000 ||
    scenario.normalization.patterns.length !== 0 ||
    scenario.arguments.length !== 2 ||
    scenario.arguments[0] !== OWNED_TIMED_FIXTURE_HEAP_ARGUMENT
  )
    throw ownedFixtureUnavailable("owned_fixture");
  validateTimedInteractions(scenario);
};

/** Capture is the only owned executable adapter whose command/env contract is presently bound. */
export const verifyOwnedProcessInput = async (
  policy: OwnedFixtureRuntimeScope,
  input: unknown,
  capability?: string,
): Promise<void> => {
  let scenario: unknown = input;
  if (typeof input === "object" && input !== null && "args" in input) {
    const args = input.args;
    if (
      typeof args !== "object" ||
      args === null ||
      !("scenario" in args) ||
      typeof args.scenario !== "string"
    )
      throw ownedFixtureUnavailable("owned_fixture");
    const seed = policy.data.files.find(
      (file) => file.path === args.scenario && file.role === "scenario",
    );
    if (seed === undefined) throw ownedFixtureUnavailable("owned_fixture");
    await admitInvestigationPath("owned_fixture", seed.path);
    const bytes = await readRegularFile(seed.path, {
      maxBytes: 1024 * 1024,
      symlinks: "reject",
      hardlinks: "reject",
    });
    if (createHash("sha256").update(bytes).digest("hex") !== seed.sha256)
      throw ownedFixtureUnavailable("owned_fixture");
    scenario = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  }
  digestOwnedFixtureInput(scenario);
  const parsed = processScenarioSchema.parse(scenario);
  const timed = capability === OWNED_TIMED_FIXTURE_CAPABILITY;
  if (timed) validateTimedScenario(policy, parsed);
  await admitInvestigationPaths("owned_fixture", parsed);
  if (
    parsed.executable !== (await realpath(process.execPath)) ||
    !policy.data.files.some(
      (file) => file.role === "executable" && file.path === parsed.executable,
    )
  )
    throw ownedFixtureUnavailable("owned_fixture");
  await bindOwnedDirectory(policy, parsed.working_directory);
  for (const [name, value] of Object.entries(parsed.environment))
    if (policy.environment[name] !== value)
      throw ownedFixtureUnavailable("owned_fixture");
  await verifyOwnedObservationFiles(
    policy,
    parsed.filesystem_observation_paths,
    parsed.working_directory,
  );
  await verifyOwnedFixtureEnvironment(policy);
  await verifyArgumentDependencies(
    policy,
    timed ? parsed.arguments.slice(1) : parsed.arguments,
    parsed.working_directory,
    timed,
  );
};

const verifyArgumentDependencies = async (
  policy: OwnedFixtureRuntimeScope,
  arguments_: readonly string[],
  workingDirectory: string,
  timed = false,
): Promise<void> => {
  const script = arguments_[0];
  if (script === undefined || !isAbsolute(script) || extname(script) !== ".mjs")
    throw ownedFixtureUnavailable("owned_fixture");
  const seed = policy.data.files.find(
    (file) => file.path === script && file.role === "dependency",
  );
  if (seed === undefined) throw ownedFixtureUnavailable("owned_fixture");
  const bytes = await readRegularFile(script, {
    maxBytes: 1024 * 1024,
    symlinks: "reject",
    hardlinks: "reject",
  });
  if (createHash("sha256").update(bytes).digest("hex") !== seed.sha256)
    throw ownedFixtureUnavailable("owned_fixture");
  (timed ? verifyOwnedTimedNodeFixtureScript : verifyOwnedNodeFixtureScript)(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  for (const argument of arguments_) {
    if (argument.startsWith("-") || /^[a-z][a-z0-9+.-]*:/iu.test(argument))
      throw ownedFixtureUnavailable("owned_fixture");
    if (hasControlCharacter(argument))
      throw ownedFixtureUnavailable("owned_fixture");
    const candidate = resolve(workingDirectory, argument);
    if (
      !policy.roots.some((root) => withinOwnedFixtureRoot(root.path, candidate))
    )
      throw ownedFixtureUnavailable("owned_fixture");
    await admitInvestigationPath("owned_fixture", candidate);
    const metadata = await lstat(candidate).catch((cause: unknown) => {
      if (
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "ENOENT"
      )
        return undefined;
      throw cause;
    });
    if (metadata !== undefined) {
      if (
        !metadata.isFile() ||
        !policy.files.some((file) => file.path === candidate)
      )
        throw ownedFixtureUnavailable("owned_fixture");
    }
  }
};
const hasControlCharacter = (value: string): boolean =>
  [...value].some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
