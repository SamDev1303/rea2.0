import { vi } from "vitest";

import { localRegistrationCommand } from "../../src/application/ClientRegistrationIdentity.js";

/** Compatibility fixture name; current setup writes the exact local Node launcher. */
export const NPX_REGISTRATION_COMMAND = localRegistrationCommand();

/** Environment variables that redirect where supported clients keep config. */
export const CLIENT_LOCATION_ENVIRONMENT = [
  "APPDATA",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "COPILOT_HOME",
  "GROK_HOME",
  "GEMINI_CLI_HOME",
  "GEMINI_CLI_TRUST_WORKSPACE",
  "GEMINI_RESTRICTED_MODE",
  "GEMINI_CLI_TRUSTED_FOLDERS_PATH",
  "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
  "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
  "HERMES_DATA_DIR_SUFFIX",
  "HERMES_HOME",
  "LOCALAPPDATA",
  "OMP_PROFILE",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "PI_CODING_AGENT_DIR",
  "PI_CONFIG_DIR",
  "PI_PROFILE",
  "QWEN_HOME",
  "SAND_DATA_ROOT",
  "XDG_CONFIG_HOME",
] as const;

/** Clear the developer's client locations so tests resolve only their temporary homes. */
export const clearClientLocationEnvironment = (): void => {
  for (const name of CLIENT_LOCATION_ENVIRONMENT) vi.stubEnv(name, undefined);
};

/** Keep text-preservation fixtures portable while giving them exact checkout ownership. */
export const localRegistrationFixtureText = (text: string): string => {
  const [command, ...args] = localRegistrationCommand();
  const encodedCommand = JSON.stringify(command);
  const encodedArgs = JSON.stringify(args);
  return text
    .replace(/args\s*=\s*\["mcp"\]/gu, `args = ${encodedArgs}`)
    .replace(
      /("command"\s*:\s*)"rea2"\s*,\s*"args"\s*:\s*\["mcp"\]/gu,
      `$1${encodedCommand},"args":${encodedArgs}`,
    )
    .replace(
      /((?:[\w.]+\.)?command\s*=\s*)["']rea2["'](\r?\n)(\s*)((?:[\w.]+\.)?args)\s*=\s*\["mcp"\]/gu,
      `$1${encodedCommand}$2$3$4 = ${encodedArgs}`,
    )
    .replace(
      /((?:[\w.]+\.)?command\s*=\s*)["']rea2["']/gu,
      (_match, key: string) => `${key}${encodedCommand}`,
    );
};
