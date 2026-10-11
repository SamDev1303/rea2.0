import { localRegistrationDisplayCommand } from "./application/ClientRegistrationIdentity.js";

/**
 * Canonical fork identity shared by local packaging, setup, MCP, and skill discovery.
 * Centralization prevents persistent client registrations from drifting from
 * the local executable exposed in package.json.
 */
export const PRODUCT_IDENTITY = {
  displayName: "REA 2.0",
  packageName: PACKAGE_METADATA.name,
  packageSpecifier: "rea2",
  registrationPackageSpecifier: "rea2",
  packageVersion: PACKAGE_METADATA.version,
  cliBinary: "rea2",
  mcpCommand: localRegistrationDisplayCommand(),
  mcpServerKey: "rea2",
  skillName: "rea2",
  sharedSkillVersion: "1.0.0",
  bundledSkillName: "reverse-engineer-anything",
  skillVersion: PACKAGE_METADATA.skillVersion,
  configFileName: "rea2.json",
} as const;

/** Exact SDK package identities, distinct from negotiated protocol version. */
export const SDK_IDENTITY = {
  server: PACKAGE_METADATA.serverSdkVersion,
  client_test: PACKAGE_METADATA.clientSdkVersion,
  core: PACKAGE_METADATA.coreSdkVersion,
} as const;
import { PACKAGE_METADATA } from "./generatedPackageMetadata.js";
