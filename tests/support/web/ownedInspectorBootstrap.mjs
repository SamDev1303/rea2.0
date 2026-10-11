import { createHash } from "node:crypto";
import { createReadStream, fstatSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const refusalStages = Object.freeze([
  "startup",
  "startup-argv",
  "startup-flags",
  "startup-env",
  "descriptor",
  "controller-read",
  "controller-json",
  "controller-shape",
  "cwd",
  "knownfixedfileidentity",
  "dist",
  "timerbytes",
  "import",
]);
const runtimeEnvironmentKeys = Object.freeze(
  process.platform === "darwin" ? ["__CF_USER_TEXT_ENCODING"] : [],
);
let refusalStage = "startup";
const refusalLabel = () =>
  refusalStages.includes(refusalStage) ? refusalStage : "startup";
const strictKeys = (value, keys) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const readController = async () => {
  refusalStage = "descriptor";
  const descriptor = fstatSync(3);
  if (!descriptor.isSocket() && !descriptor.isFIFO())
    throw new Error("controller descriptor");
  refusalStage = "controller-read";
  const chunks = [];
  let size = 0;
  const stream = createReadStream("", {
    fd: 3,
    autoClose: true,
    signal: AbortSignal.timeout(2000),
  });
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > 4096) throw new Error("controller size");
    chunks.push(chunk);
  }
  refusalStage = "controller-json";
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};
const checkFile = async (value, path) => {
  if (!strictKeys(value, ["path", "dev", "ino", "sha256"]))
    throw new Error("file shape");
  const metadata = await lstat(path);
  if (
    value.path !== path ||
    (await realpath(path)) !== path ||
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    value.dev !== metadata.dev ||
    value.ino !== metadata.ino ||
    typeof value.sha256 !== "string" ||
    value.sha256 !==
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex")
  )
    throw new Error("file identity");
};
const bootstrap = async () => {
  refusalStage = "startup-argv";
  if (process.argv.length !== 2) throw new Error("startup shape");
  refusalStage = "startup-flags";
  if (
    process.execArgv.length !== 1 ||
    process.execArgv[0] !== "--inspect=127.0.0.1:0"
  )
    throw new Error("startup shape");
  refusalStage = "startup-env";
  if (
    Object.keys(process.env).some(
      (key) => !runtimeEnvironmentKeys.includes(key),
    )
  )
    throw new Error("startup shape");
  const value = await readController();
  refusalStage = "controller-shape";
  if (
    !strictKeys(value, ["cwd", "node", "bootstrap", "timer"]) ||
    !strictKeys(value.cwd, ["path", "dev", "ino"])
  )
    throw new Error("controller shape");
  refusalStage = "cwd";
  const cwd = await realpath(process.cwd());
  const directory = await lstat(cwd);
  if (
    !directory.isDirectory() ||
    value.cwd.path !== cwd ||
    value.cwd.dev !== directory.dev ||
    value.cwd.ino !== directory.ino
  )
    throw new Error("directory identity");
  const fixture = join(cwd, "probe #百分比 %.cjs");
  refusalStage = "knownfixedfileidentity";
  await checkFile(value.node, await realpath(process.execPath));
  refusalStage = "knownfixedfileidentity";
  await checkFile(value.bootstrap, fileURLToPath(import.meta.url));
  refusalStage = "knownfixedfileidentity";
  await checkFile(value.timer, fixture);
  refusalStage = "timerbytes";
  if ((await readFile(fixture, "utf8")) !== "setInterval(() => {}, 25);\n")
    throw new Error("timer source");
  refusalStage = "import";
  await import(pathToFileURL(fixture).href);
  process.stderr.write("Owned Inspector fixture ready.\n");
};
await bootstrap().catch(() => {
  process.stderr.write(
    `Owned Inspector fixture controller refused: ${refusalLabel()}.\n`,
  );
  process.stderr.write("Owned Inspector fixture stopped.\n", () =>
    process.exit(1),
  );
});
