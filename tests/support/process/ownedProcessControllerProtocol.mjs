import { createHash } from "node:crypto";
import { lstat, realpath, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { OwnedProcessControllerResources } from "./ownedProcessControllerResources.mjs";
import { describeOwnedProcessTemplate } from "./ownedProcessTemplates.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) =>
  a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.uid === b.uid;
const fields = (value, keys) => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== keys.slice().sort().join()
  )
    throw new Error("Malformed controller receipt");
};

export async function ownedDirectoryIdentity(path, privateRoot = false) {
  const temporary = await realpath(tmpdir());
  if (
    !isAbsolute(path) ||
    !path.startsWith(temporary + sep) ||
    path !== (await realpath(path))
  )
    throw new Error("Controller directory must be a canonical temporary path");
  let selected = path;
  while (selected !== temporary) {
    const metadata = await lstat(selected);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o022) !== 0 ||
      metadata.uid !== process.getuid?.()
    )
      throw new Error("Unowned controller directory");
    selected = dirname(selected);
  }
  const metadata = await lstat(path);
  if (privateRoot && (metadata.mode & 0o077) !== 0)
    throw new Error("Controller root is not private");
  return {
    path,
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
    uid: metadata.uid,
  };
}

export async function ownedFileIdentity(
  path,
  resources = new OwnedProcessControllerResources(),
) {
  if (!isAbsolute(path) || path !== (await realpath(path)))
    throw new Error("File path is not canonical");
  const before = await lstat(path);
  if (!before.isFile() || before.nlink !== 1 || before.isSymbolicLink())
    throw new Error("Controller file is not single-link regular data");
  return resources.withFile(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    async (handle) => {
      const opened = await handle.stat();
      if (!same(before, opened) || !opened.isFile() || opened.nlink !== 1)
        throw new Error("Controller file changed before read");
      if (opened.size > 256 * 1024 * 1024)
        throw new Error("Controller file exceeds byte budget");
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(65536);
      let bytes = 0;
      while (bytes < opened.size) {
        const part = await handle.read(
          buffer,
          0,
          Math.min(buffer.length, opened.size - bytes),
          bytes,
        );
        if (part.bytesRead === 0)
          throw new Error("Controller file ended before sealed size");
        bytes += part.bytesRead;
        hash.update(buffer.subarray(0, part.bytesRead));
      }
      const after = await handle.stat();
      if (
        !same(opened, after) ||
        after.size !== bytes ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs
      )
        throw new Error("Controller file changed during read");
      return {
        path,
        dev: after.dev,
        ino: after.ino,
        mode: after.mode,
        uid: after.uid,
        size: after.size,
        sha256: hash.digest("hex"),
      };
    },
  );
}

async function exactInventory(root, paths) {
  const expected = new Set(paths);
  const pending = [root];
  let visited = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const name of await readdir(directory)) {
      if (++visited > 32) throw new Error("Controller seed inventory exceeded");
      const path = join(directory, name);
      if (!expected.delete(path))
        throw new Error("Unexpected controller seed descendant");
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error("Controller seed symlink");
      if (metadata.isDirectory()) pending.push(path);
      else if (!metadata.isFile() || metadata.nlink !== 1)
        throw new Error("Unsafe controller seed entry");
    }
  }
  if (expected.size > 0) throw new Error("Missing controller seed descendant");
}

const verifySealedIdentities = async (
  data,
  { dirs, files, privateRoots, resources },
) => {
  if (
    !Array.isArray(data.directories) ||
    !Array.isArray(data.files) ||
    data.directories.length !== dirs.length ||
    data.files.length !== files.length
  )
    throw new Error("Invalid finite controller inventory");
  for (const [index, path] of dirs.entries()) {
    const expected = data.directories[index];
    fields(expected, ["path", "dev", "ino", "mode", "uid"]);
    const actual = await ownedDirectoryIdentity(
      path,
      privateRoots.includes(path),
    );
    if (expected.path !== path || !same(expected, actual))
      throw new Error("Controller directory identity changed");
  }
  for (const [index, path] of files.entries()) {
    const expected = data.files[index];
    fields(expected, ["path", "dev", "ino", "mode", "uid", "size", "sha256"]);
    const actual = await ownedFileIdentity(path, resources);
    if (JSON.stringify(expected) !== JSON.stringify(actual))
      throw new Error("Controller file identity changed");
  }
};

/** Reconstruct the finite template and check every initial acquisition before dispatch. */
export async function validateOwnedProcessControllerData(
  data,
  resources = new OwnedProcessControllerResources(),
) {
  fields(data, [
    "selection",
    "control_root",
    "program",
    "scenario",
    "directories",
    "files",
    "executable",
  ]);
  const control = await ownedDirectoryIdentity(data.control_root, true);
  const program = join(control.path, "program.mjs");
  const scenario = join(control.path, "scenario.json");
  if (data.program !== program || data.scenario !== scenario)
    throw new Error("Invalid controller carrier");
  const executable = await realpath(
    data.selection.template === "printenv"
      ? "/usr/bin/printenv"
      : process.execPath,
  );
  if (data.executable.path !== executable)
    throw new Error("Wrong maintained executable");
  const description = describeOwnedProcessTemplate(
    data.selection,
    executable,
    program,
  );
  const dirs = [control.path, ...description.roots, ...description.directories];
  const files = [
    program,
    scenario,
    ...description.seeds.map(([path]) => path),
    executable,
  ];
  await verifySealedIdentities(data, {
    dirs,
    files,
    privateRoots: [control.path, ...description.roots],
    resources,
  });
  await exactInventory(control.path, [program, scenario]);
  for (const root of description.roots) {
    const contents = [
      ...description.directories,
      ...description.seeds.map(([path]) => path),
    ].filter(
      (path) =>
        relative(root, path) !== "" &&
        !relative(root, path).startsWith("..") &&
        !isAbsolute(relative(root, path)),
    );
    await exactInventory(root, contents);
  }
  if (
    data.files[0].sha256 !== digest(description.source) ||
    data.files[1].sha256 !== digest(JSON.stringify(description.scenario))
  )
    throw new Error("Controller carrier differs from authored template");
  for (const [index, seed] of description.seeds.entries())
    if (data.files[index + 2].sha256 !== digest(seed[1]))
      throw new Error("Controller seed content differs");
  if (JSON.stringify(data.executable) !== JSON.stringify(data.files.at(-1)))
    throw new Error("Controller executable receipt differs");
  return description.scenario;
}
