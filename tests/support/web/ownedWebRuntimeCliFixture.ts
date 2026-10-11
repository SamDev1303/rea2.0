import { createHash, randomBytes } from "node:crypto";
import { once } from "node:events";
import { lstat, readFile, opendir, realpath } from "node:fs/promises";
import { createServer, get } from "node:http";
import type { Socket } from "node:net";
import { fileURLToPath } from "node:url";

import { startRuntimeBrowser } from "../../fixtures/webRuntime.js";
import type { TestProcesses } from "../process/processFixture.js";

type Command = "observe-web-execution" | "inspect-web-event-listeners";
export interface OwnedWebRuntimeEndpoint {
  readonly fixture: "owned-web-runtime-endpoint";
}

interface EndpointScope {
  readonly endpoint: string;
  readonly kind: "browser" | "discovery-hang";
  readonly contactNonce: string;
  closing: boolean;
  readonly leases: Set<Promise<void>>;
  shutdown?: Promise<void>;
}
const endpoints = new WeakMap<OwnedWebRuntimeEndpoint, EndpointScope>();
const checkoutUrl = new URL("../../../", import.meta.url);
const bootstrapUrl = new URL(
  "./ownedWebRuntimeCliBootstrap.mjs",
  import.meta.url,
);
const assetNames = [
  "dist/cli/webRuntimeCommands.js",
  "dist/cli/commandCancellation.js",
] as const;

const declareEndpoint = (
  endpoint: string,
  kind: EndpointScope["kind"],
  contactNonce = randomBytes(32).toString("hex"),
) => {
  const token: OwnedWebRuntimeEndpoint = Object.freeze({
    fixture: "owned-web-runtime-endpoint",
  });
  const scope: EndpointScope = {
    endpoint,
    kind,
    contactNonce,
    closing: false,
    leases: new Set(),
  };
  endpoints.set(token, scope);
  return { token, scope };
};

const shutdownEndpoint = (scope: EndpointScope, stop: () => Promise<void>) => {
  scope.closing = true;
  scope.shutdown ??= (async () => {
    await Promise.all(scope.leases);
    await stop();
  })();
  return scope.shutdown;
};

const leaseEndpoint = (token: OwnedWebRuntimeEndpoint) => {
  const scope = endpoints.get(token);
  if (scope === undefined || scope.closing)
    throw new Error("Only a live constructor-owned web fixture is selectable");
  let finish!: () => void;
  const lease = new Promise<void>((resolve) => {
    finish = resolve;
  });
  scope.leases.add(lease);
  let released = false;
  return {
    scope,
    release() {
      if (released) return;
      released = true;
      scope.leases.delete(lease);
      finish();
    },
  };
};

/** The endpoint comes from this authored fixture factory, never a caller URL. */
export const createOwnedWebRuntimeBrowser = async () => {
  const browser = await startRuntimeBrowser();
  const { token, scope } = declareEndpoint(browser.endpoint, "browser");
  return {
    token,
    browser: Object.freeze({ commands: browser.commands }),
    close: () => shutdownEndpoint(scope, () => browser.close()),
  };
};

/** A real owned HTTP listener holds discovery open for cancellation probes. */
export const createOwnedWebDiscoveryHang = async () => {
  const sockets = new Set<Socket>();
  let markContact!: () => void;
  const contacted = new Promise<void>((resolve) => {
    markContact = resolve;
  });
  const nonce = randomBytes(32).toString("hex");
  const server = createServer((request, response) => {
    if (
      request.method === "GET" &&
      request.url === "/json/version" &&
      request.headers["x-rea-owned-contact"] === nonce
    ) {
      markContact();
      return;
    }
    response.writeHead(204).end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Owned discovery fixture has no TCP address");
  const { token, scope } = declareEndpoint(
    `http://127.0.0.1:${String(address.port)}`,
    "discovery-hang",
    nonce,
  );
  return {
    token,
    contacted,
    probeUnrelatedContact: () =>
      new Promise<void>((resolve, reject) => {
        const request = get(
          `${scope.endpoint}/json/version`,
          {
            headers: { "x-rea-owned-unrelated-probe": "1" },
          },
          (response) => {
            response.resume();
            response.once("end", resolve);
          },
        );
        request.once("error", reject);
      }),
    close: () =>
      shutdownEndpoint(scope, async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((cause) =>
            cause === undefined ? resolve() : reject(cause),
          ),
        );
      }),
  };
};

const identifyFile = async (url: URL) => {
  const path = await realpath(fileURLToPath(url));
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.nlink !== 1)
    throw new Error("Owned registration asset is not a single-link file");
  return {
    path,
    dev: metadata.dev,
    ino: metadata.ino,
    sha256: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  };
};

const distFingerprint = async () => {
  const root = fileURLToPath(new URL("dist/", checkoutUrl)).replace(/\/$/u, "");
  if ((await realpath(root)) !== root) throw new Error("Aliased dist root");
  const records: unknown[] = [];
  let bytes = 0;
  let visited = 1;
  const visit = async (path: string, relative: string): Promise<void> => {
    const metadata = await lstat(path);
    if (metadata.isDirectory()) {
      records.push([relative, "directory", metadata.dev, metadata.ino]);
      const names: string[] = [];
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

const prepareLaunch = async (
  scope: EndpointScope,
  command: Command,
  mode: "success" | "signal-probe",
) => {
  if (
    typeof command !== "string" ||
    !/^(?:observe-web-execution|inspect-web-event-listeners)$/u.test(command)
  )
    throw new Error("Unsupported owned web command");
  const cwd = await realpath(fileURLToPath(checkoutUrl));
  const directory = await lstat(cwd);
  const bootstrap = await identifyFile(bootstrapUrl);
  const distSha256 = await distFingerprint();
  const assets = await Promise.all(
    assetNames.map((name) => identifyFile(new URL(name, checkoutUrl))),
  );
  if (!directory.isDirectory())
    throw new Error("Owned web checkout is not a directory");
  if (mode === "success" && scope.kind !== "browser")
    throw new Error("Discovery-hang fixtures only support signal probes");
  return {
    bootstrap,
    cwd,
    controllerData: JSON.stringify({
      command,
      mode,
      endpoint: scope.endpoint,
      kind: scope.kind,
      contact_nonce: scope.contactNonce,
      cwd: { path: cwd, dev: directory.dev, ino: directory.ino },
      assets,
      bootstrap,
      dist_sha256: distSha256,
    }),
  };
};

/** Fixed maintained registration driver, not public createCli or host admission. */
export const runOwnedWebRuntimeCli = async (
  processes: TestProcesses,
  token: OwnedWebRuntimeEndpoint,
  command: Command,
) => {
  const child = await launchOwnedWebChild(processes, token, command, "success");
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let outputBytes = 0;
  let failure: unknown;
  const collect = (chunk: Buffer, output: "stdout" | "stderr") => {
    outputBytes += chunk.length;
    if (outputBytes > 1024 * 1024) {
      failure ??= new Error("Owned web CLI exceeded its output budget");
      child.kill("SIGTERM");
      return;
    }
    if (output === "stdout") stdout.push(chunk);
    else stderr.push(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
  child.stderr.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
  return new Promise<import("../process/processFixture.js").ProcessResult>(
    (resolve, reject) => {
      child.on("error", (cause) => {
        failure ??= cause;
        if (child.pid === undefined) reject(cause);
      });
      child.once("close", (exitCode, signal) => {
        if (failure !== undefined) reject(failure);
        else
          resolve({
            exitCode,
            signal,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
      });
    },
  );
};

/** Signals reach the actual compiled cancellation helper in this owned child. */
const launchOwnedWebChild = async (
  processes: TestProcesses,
  token: OwnedWebRuntimeEndpoint,
  command: Command,
  mode: "success" | "signal-probe",
) => {
  const lease = leaseEndpoint(token);
  try {
    const launch = await prepareLaunch(lease.scope, command, mode);
    const child = processes.spawnWithControllerData(
      process.execPath,
      [launch.bootstrap.path],
      launch.controllerData,
      { cwd: launch.cwd, env: {} },
    );
    let killDeadline: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => {
      child.kill("SIGTERM");
      killDeadline = setTimeout(() => child.kill("SIGKILL"), 1000);
      killDeadline.unref();
    }, 20_000);
    deadline.unref();
    let outputBytes = 0;
    const drain = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > 1024 * 1024) child.kill("SIGTERM");
    };
    child.stdout.on("data", drain);
    child.stderr.on("data", drain);
    const finish = () => {
      clearTimeout(deadline);
      clearTimeout(killDeadline);
      lease.release();
    };
    child.once("close", finish);
    child.on("error", () => {
      // A failed spawn has no process to retain. A live-child error keeps its
      // lease until close so the fixture endpoint cannot be recycled early.
      if (child.pid === undefined) finish();
      else child.kill("SIGTERM");
    });
    return child;
  } catch (cause) {
    lease.release();
    throw cause;
  }
};

export const spawnOwnedWebRuntimeCli = (
  processes: TestProcesses,
  token: OwnedWebRuntimeEndpoint,
  command: Command,
) => launchOwnedWebChild(processes, token, command, "signal-probe");
