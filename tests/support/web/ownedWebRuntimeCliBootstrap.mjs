import { createHash } from "node:crypto";
import { createReadStream, fstatSync } from "node:fs";
import { lstat, readFile, opendir, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";

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
const checkout = new URL("../../../", import.meta.url);
const fixedAssets = [
  new URL("dist/cli/webRuntimeCommands.js", checkout),
  new URL("dist/cli/commandCancellation.js", checkout),
];
const strictKeys = (value, keys) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

const readController = async () => {
  refusalStage = "descriptor";
  const descriptor = fstatSync(3);
  if (!descriptor.isSocket() && !descriptor.isFIFO())
    throw new Error("Missing private controller pipe");
  refusalStage = "controller-read";
  const chunks = [];
  let bytes = 0;
  const stream = createReadStream("", {
    fd: 3,
    autoClose: true,
    signal: AbortSignal.timeout(2000),
  });
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > 4096) throw new Error("Oversized web fixture controller data");
    chunks.push(chunk);
  }
  refusalStage = "controller-json";
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const validateAsset = async (selected, url) => {
  if (!strictKeys(selected, ["path", "dev", "ino", "sha256"]))
    throw new Error("Malformed registration identity");
  const path = await realpath(fileURLToPath(url));
  const metadata = await lstat(path);
  if (
    selected.path !== path ||
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    selected.dev !== metadata.dev ||
    selected.ino !== metadata.ino ||
    !/^[a-f0-9]{64}$/u.test(selected.sha256) ||
    selected.sha256 !==
      createHash("sha256")
        .update(await readFile(path))
        .digest("hex")
  )
    throw new Error("Registration asset identity changed");
};

const distFingerprint = async () => {
  const root = fileURLToPath(new URL("dist/", checkout)).replace(/\/$/u, "");
  if ((await realpath(root)) !== root) throw new Error("Aliased dist root");
  const records = [];
  let bytes = 0;
  let visited = 1;
  const visit = async (path, relative) => {
    const metadata = await lstat(path);
    if (metadata.isDirectory()) {
      records.push([relative, "directory", metadata.dev, metadata.ino]);
      const names = [];
      const directory = await opendir(path);
      for await (const entry of directory) {
        if (++visited > 4096) throw new Error("Oversized dist inventory");
        names.push(entry.name);
      }
      for (const name of names.sort())
        await visit(`${path}/${name}`, `${relative}/${name}`);
      return;
    }
    if (!metadata.isFile() || metadata.nlink !== 1)
      throw new Error("Dist contains an alias or nonregular carrier");
    if (!/\.(?:js|json)$/u.test(relative)) return;
    bytes += metadata.size;
    if (bytes > 64 * 1024 * 1024) throw new Error("Oversized dist closure");
    const content = await readFile(path);
    if (content.length !== metadata.size)
      throw new Error("Dist changed during hash");
    records.push([
      relative,
      "file",
      metadata.dev,
      metadata.ino,
      metadata.size,
      createHash("sha256").update(content).digest("hex"),
    ]);
  };
  await visit(root.replace(/\/$/u, ""), "dist");
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
};

const validateShape = (value) => {
  if (
    !strictKeys(value, [
      "command",
      "mode",
      "endpoint",
      "kind",
      "contact_nonce",
      "cwd",
      "assets",
      "bootstrap",
      "dist_sha256",
    ]) ||
    !["observe-web-execution", "inspect-web-event-listeners"].includes(
      value.command,
    ) ||
    !["browser", "discovery-hang"].includes(value.kind) ||
    !["success", "signal-probe"].includes(value.mode) ||
    (value.mode === "success" && value.kind !== "browser") ||
    typeof value.endpoint !== "string" ||
    typeof value.contact_nonce !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.contact_nonce) ||
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{3,4}$/u.test(value.endpoint) ||
    Number(new URL(value.endpoint).port) < 1024 ||
    !strictKeys(value.cwd, ["path", "dev", "ino"]) ||
    typeof value.dist_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.dist_sha256) ||
    !Array.isArray(value.assets) ||
    value.assets.length !== fixedAssets.length
  )
    throw new Error("Malformed owned web controller scope");
};

const validateController = async (value) => {
  refusalStage = "controller-shape";
  validateShape(value);
  refusalStage = "cwd";
  const cwd = await realpath(fileURLToPath(checkout));
  const directory = await lstat(cwd);
  if (
    process.cwd() !== cwd ||
    value.cwd.path !== cwd ||
    !directory.isDirectory() ||
    value.cwd.dev !== directory.dev ||
    value.cwd.ino !== directory.ino
  )
    throw new Error("Owned web checkout identity changed");
  refusalStage = "knownfixedfileidentity";
  await validateAsset(value.bootstrap, import.meta.url);
  refusalStage = "knownfixedfileidentity";
  for (const [index, url] of fixedAssets.entries())
    await validateAsset(value.assets[index], url);
  refusalStage = "dist";
  if (value.dist_sha256 !== (await distFingerprint()))
    throw new Error("Dist closure changed");
  return value;
};

const bootstrap = async () => {
  refusalStage = "startup-argv";
  if (process.argv.length !== 2) throw new Error("startup shape");
  refusalStage = "startup-flags";
  if (process.execArgv.length !== 0) throw new Error("startup shape");
  refusalStage = "startup-env";
  if (
    Object.keys(process.env).some(
      (key) => !runtimeEnvironmentKeys.includes(key),
    )
  )
    throw new Error("startup shape");
  const scope = await validateController(await readController());
  return scope;
};

const runMaintainedCommand = async (scope) => {
  // Authenticate only the authored hanging listener's real CDP request.
  // Port probes cannot otherwise prove this child reached its signal boundary.
  if (scope.kind === "discovery-hang") {
    const originalRequest = http.request;
    http.request = function (url, options, callback) {
      if (
        url instanceof URL &&
        url.origin === scope.endpoint &&
        url.pathname === "/json/version" &&
        options?.method === "GET"
      ) {
        return originalRequest.call(
          http,
          url,
          {
            ...options,
            headers: {
              ...options.headers,
              "x-rea-owned-contact": scope.contact_nonce,
            },
          },
          callback,
        );
      }
      return originalRequest.call(http, url, options, callback);
    };
    syncBuiltinESMExports();
  }
  const [{ Cli }, { default: pino }, { registerWebRuntimeCommands }] =
    await Promise.all([
      import("incur"),
      import("pino"),
      import(fixedAssets[0].href),
    ]);
  const cli = Cli.create("rea2-owned-web-registration", { sync: false });
  registerWebRuntimeCommands(cli, pino({ level: "silent" }));
  const target = scope.kind === "browser" ? "allowed-page" : "page-fixture";
  const argv =
    scope.command === "observe-web-execution"
      ? [
          scope.command,
          scope.endpoint,
          target,
          "--observation-ms",
          scope.mode === "signal-probe" ? "30000" : "250",
          "--json",
        ]
      : [
          scope.command,
          scope.endpoint,
          target,
          scope.kind === "browser" ? "#selected" : "body",
          "--json",
        ];
  await cli.serve(argv, { env: {} });
};

let scope;
try {
  const candidate = await bootstrap();
  await validateController(candidate);
  scope = candidate;
} catch {
  process.stderr.write(
    `Owned web registration controller refused: ${refusalLabel()}.\n`,
  );
  process.exitCode = 1;
}
if (scope !== undefined) {
  try {
    await runMaintainedCommand(scope);
  } catch {
    process.stderr.write("Owned web maintained command failed.\n");
    if (process.exitCode === undefined || process.exitCode === 0)
      process.exitCode = 1;
  }
}
