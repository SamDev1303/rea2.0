import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve this checkout's launcher; no package runner or upstream fallback. */
export const localRegistrationCommand = (): readonly string[] => [
  process.execPath,
  fileURLToPath(new URL("../../scripts/rea.mjs", import.meta.url)),
  "mcp",
];

/** Compatibility export for callers compiled against the former helper name. */
export const npxRegistrationCommand = (
  _platform: NodeJS.Platform = process.platform,
): readonly string[] => localRegistrationCommand();

/** Ownership requires the exact Node executable and exact checkout entry point. */
export const isOwnedClientRegistrationCommand = (
  command: readonly string[],
  currentCommandPath: string = localRegistrationCommand()[1]!,
): boolean => {
  if (command.length !== 3 || command[2] !== "mcp") return false;
  return (
    resolve(command[0] ?? "") === resolve(process.execPath) &&
    resolve(command[1] ?? "") === resolve(currentCommandPath)
  );
};

/** Display-only shell command; persistent clients use the structured argument array. */
export const localRegistrationDisplayCommand = (
  platform: NodeJS.Platform = process.platform,
): string => {
  const quote = (value: string): string =>
    platform === "win32"
      ? `'${value.replaceAll("'", "''")}'`
      : `'${value.replaceAll("'", `'"'"'`)}'`;
  return `${platform === "win32" ? "& " : ""}${localRegistrationCommand().map(quote).join(" ")}`;
};
