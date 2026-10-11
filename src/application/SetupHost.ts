import { access } from "node:fs/promises";

import { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import { ConfigurationError } from "../domain/configurationErrors.js";
import { localRegistrationCommand } from "./ClientRegistrationIdentity.js";
import {
  SUPPORTED_NODE_VERSION_PROSE,
  supportsNodeVersion,
} from "../domain/runtimeVersion.js";
import { runDoctor, systemDoctorHost, type DoctorHost } from "./Doctor.js";
import { readLinuxDistribution } from "./LinuxHopper.js";
import {
  clientEvidencePaths,
  supportedClients,
  type SetupClient,
} from "./SupportedClients.js";
import { skillDestinations } from "./SetupSkill.js";
import {
  clientConfigurationAligned,
  configureClientConfiguration,
  inspectClientConfiguration,
} from "./SetupClientConfiguration.js";
import {
  RegularFileCleanupFailure,
  retryRegularFileCleanup,
} from "./RegularFileRead.js";
import { providerRegistrationEnvironment } from "./SetupRegistrationEnvironment.js";
import type {
  SetupHost,
  SetupInitialState,
  SetupProviderEnvironment,
} from "./SetupTypes.js";
import type { DoctorScope } from "./Doctor.js";

/** Resolve the executable and arguments used in a managed MCP registration. */
export const setupRegistrationCommand = (
  _platform: NodeJS.Platform,
  _useNpmRunner: boolean,
): readonly string[] => localRegistrationCommand();

export const filterClientsNeedingConfigure = async (
  host: SetupHost,
  detectedClients: readonly SetupClient[],
  providerEnvironment: SetupProviderEnvironment,
  command: readonly string[],
): Promise<readonly SetupClient[]> => {
  const needs = await Promise.all(
    detectedClients.map((client) =>
      host.clientNeedsConfigure(client, providerEnvironment, command),
    ),
  );
  return detectedClients.filter((_, index) => needs[index]);
};

export const hostRemediation = async (
  host: SetupHost,
  installHopper: boolean,
): Promise<string | undefined> => {
  if (!supportsNodeVersion(host.nodeVersion))
    return `Install ${SUPPORTED_NODE_VERSION_PROSE} and rerun setup.`;
  if (!installHopper) return undefined;
  if (host.platform !== "darwin" && host.platform !== "linux")
    return "REA supports Hopper on macOS and selected 64-bit Linux distributions.";
  if (host.platform === "darwin") {
    const version = await host.macosVersion();
    return version === undefined || major(version) < 12
      ? "Upgrade to macOS 12 or newer."
      : undefined;
  }
  if ((await host.linuxDistribution())?.supported === true) return undefined;
  return "Automated Hopper setup supports Ubuntu 24.04+, Fedora 41+, Nobara 44+, 64-bit Arch Linux, CachyOS, and Omarchy; configure an existing supported provider instead.";
};

/** Production setup effects for additive client configuration; engine and skill installs are disabled. */
export const systemSetupHost = (
  selectedDoctorHost: DoctorHost | undefined = undefined,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): SetupHost => {
  const doctorHost = selectedDoctorHost ?? systemDoctorHost({ environment });
  const platform = doctorHost.platform;
  const { homeDirectory } = doctorHost;
  const resources = new ArtifactResourceScope();
  return {
    engineInstallationDisabled: true,
    skillManagedExternally: true,
    platform,
    homeDirectory,
    skillDestinations: (clientIds) =>
      skillDestinations(homeDirectory, clientIds, environment, platform),
    registrationCommand: setupRegistrationCommand(
      platform,
      environment.npm_command === "exec",
    ),
    nodeVersion: process.versions.node,
    macosVersion: () => doctorHost.macosVersion(),
    linuxDistribution: readLinuxDistribution,
    close: () => closeSetupResources(resources),
    initialSetupState: async (
      scope?: DoctorScope,
    ): Promise<SetupInitialState> => {
      const diagnosis = await runDoctor(undefined, doctorHost, scope);
      return {
        ...(diagnosis.hopperPath === undefined
          ? {}
          : { hopperPath: diagnosis.hopperPath }),
        providerEnvironment: {
          ...providerRegistrationEnvironment(
            diagnosis.providerInspections ?? [],
          ),
          ...(diagnosis.hopperPath === undefined
            ? {}
            : { HOPPER_LAUNCHER_PATH: diagnosis.hopperPath }),
        },
        doctor: diagnosis,
      };
    },
    installHopper: () =>
      Promise.resolve({
        status: "failed" as const,
        code: "unsupported_host" as const,
        remediation:
          "REA 2.0 does not install analysis engines. Review and install trusted tooling separately; investigation targets must never be installed on these Macs.",
      }),
    detectedClients: () => detectClients(homeDirectory, platform, environment),
    supportedClients: () =>
      Promise.resolve(supportedClients(homeDirectory, platform, environment)),
    ...clientConfigurationOperations(resources),
    // The shared skill registry owns /rea2. Setup never overwrites its mirrors.
    skillNeedsInstall: () => Promise.resolve(false),
    installSkill: () => Promise.resolve("failed" as const),
    doctor: (scope) => runDoctor(undefined, doctorHost, scope),
  };
};

const clientConfigurationOperations = (resources: ArtifactResourceScope) => ({
  configureClient: (
    client: SetupClient,
    providerEnvironment: SetupProviderEnvironment,
    command: readonly string[],
  ) =>
    runClientConfigurationOperation(resources, async () =>
      client.format === "unsupported"
        ? { status: "skipped" as const }
        : configureClientConfiguration(client, providerEnvironment, command),
    ),
  clientNeedsConfigure: (
    client: SetupClient,
    providerEnvironment: SetupProviderEnvironment,
    command: readonly string[],
  ) =>
    runClientConfigurationOperation(resources, async () =>
      client.format === "unsupported"
        ? false
        : !(await clientConfigurationAligned(
            client,
            providerEnvironment,
            command,
          )),
    ),
  inspectClientConfiguration: (
    client: SetupClient,
    providerEnvironment: SetupProviderEnvironment,
    command: readonly string[],
  ) =>
    runClientConfigurationOperation(resources, () =>
      inspectClientConfiguration(client, providerEnvironment, command),
    ),
});

const closeSetupResources = async (
  resources: ArtifactResourceScope,
): Promise<string | undefined> => {
  try {
    await resources.close();
    return undefined;
  } catch (cause: unknown) {
    return errorMessage(cause);
  }
};

const runClientConfigurationOperation = async <Value>(
  resources: ArtifactResourceScope,
  operation: () => Promise<Value>,
): Promise<Value> => {
  try {
    return await resources.run(async () => {
      try {
        return await operation();
      } catch (cause: unknown) {
        if (!(cause instanceof RegularFileCleanupFailure)) throw cause;
        const cleanup = await retryRegularFileCleanup(cause, resources);
        const primary =
          cleanup.outcome.kind === "failed"
            ? cleanup.outcome.cause
            : cause.cleanupCause;
        throw configurationCleanupError(
          `Could not safely access client configuration at ${cause.path}: ${errorMessage(primary)}`,
          cause,
          cleanup.cleanup,
        );
      }
    });
  } catch (cause: unknown) {
    if (cause instanceof ArtifactReaderFailure)
      throw configurationCleanupError(cause.message, cause, cause.cleanup);
    throw cause;
  }
};

const configurationCleanupError = (
  message: string,
  cause: unknown,
  cleanup:
    | { readonly reason: string; readonly resources: readonly string[] }
    | undefined,
): ConfigurationError =>
  new ConfigurationError(message, {
    cause,
    settings: [{ setting: "client configuration", constraint: message }],
    ...(cleanup === undefined ? {} : { cleanup }),
  });

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Detect supported agents from their config files or stable installation markers. */
export const detectClients = async (
  home: string,
  platform: NodeJS.Platform = process.platform,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<readonly SetupClient[]> => {
  const detected: SetupClient[] = [];
  for (const candidate of supportedClients(home, platform, environment)) {
    if (candidate.configPathError !== undefined) continue;
    if (await clientEvidencePresent(candidate)) detected.push(candidate);
  }
  return detected;
};

const major = (version: string): number =>
  Number.parseInt(version.split(".")[0] ?? "0", 10);
const clientEvidencePresent = async (client: SetupClient): Promise<boolean> => {
  for (const path of clientEvidencePaths(client))
    if (await exists(path)) return true;
  return false;
};

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch (cause: unknown) {
    // best-effort cleanup: optional host probing; absence means unavailable.
    void cause;
    return false;
  }
};
