import { homedir, userInfo } from "node:os";
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";

/** Explicit protected file classes; target text never changes this policy. */
export const isProtectedReferencePath = (path: string): boolean =>
  path.split(/[\\/]/u).some((part) => {
    const name = part
      .normalize("NFD")
      .toLowerCase()
      .replace(/(?:\.bak|\.backup|~)+$/u, "");
    return (
      [
        ".git",
        ".ssh",
        ".gnupg",
        ".aws",
        ".azure",
        ".kube",
        "secrets",
        "oauth",
        "keys.md",
        "master.env",
        "shared.env",
        "tools.env",
        ".config",
        ".docker",
        ".npmrc",
        ".yarnrc",
        ".pypirc",
        ".netrc",
        ".git-credentials",
        ".gitconfig",
        ".zshenv",
        ".zshrc",
        ".zprofile",
        ".bashrc",
        ".bash_profile",
        ".profile",
        ".grok",
        ".agy",
        ".opencode",
        ".pgpass",
        "id_rsa",
        "id_ed25519",
        "id_ecdsa",
      ].includes(name) ||
      name === ".env" ||
      name.startsWith(".env.") ||
      /\.(?:pem|key|p12|pfx|ppk|p8|kdbx|jks|keystore|keychain|keychain-db)$/u.test(
        name,
      )
    );
  });

const within = (root: string, path: string): boolean =>
  path === root || path.startsWith(`${root}${sep}`);

/** Resolve parent aliases too, including a not-yet-created output leaf. */
export const canonicalAdmissionPath = async (path: string): Promise<string> => {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (cause: unknown) {
    if (
      !(
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "ENOENT"
      )
    )
      throw cause;
    const parent = dirname(absolute);
    if (parent === absolute) throw cause;
    return resolve(await canonicalAdmissionPath(parent), basename(absolute));
  }
};

/** Protect explicit credentials and personal stores before reading or writing. */
export const isProtectedHostPath = (path: string): boolean => {
  const absolute = resolve(path).normalize("NFD").toLowerCase();
  const homes = new Set(
    [userInfo().homedir, homedir()].map((home) =>
      resolve(home).normalize("NFD").toLowerCase(),
    ),
  );
  return (
    isProtectedReferencePath(absolute) ||
    absolute === sep ||
    [...homes].some(
      (home) =>
        absolute === home ||
        [
          "Library",
          "Sync",
          "Desktop",
          "Documents",
          "Downloads",
          "Pictures",
          "Movies",
          "Music",
          "Public",
          ".codex",
          ".claude",
          ".agents",
          "api",
        ].some((part) => within(resolve(home, part).toLowerCase(), absolute)),
    )
  );
};
