import { createReadStream, fstatSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Fixture controller entry; absent from the public launcher and package file list. */
export const ownedCliBootstrapPath = fileURLToPath(import.meta.url);

const readControllerData = async () => {
  const metadata = fstatSync(3);
  // nodeSpawn's extra stdio pipe is a socket. On macOS an absent FD3 can
  // instead be Node's kqueue (reported as FIFO); never read or close it.
  if (!metadata.isSocket())
    throw new Error("A private inherited controller pipe is required");
  const chunks = [];
  let bytes = 0;
  const stream = createReadStream("", {
    fd: 3,
    autoClose: true,
    signal: AbortSignal.timeout(5000),
  });
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > 1024 * 1024)
      throw new Error("Controller data exceeds the fixture byte budget");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

const isDirectoryIdentity = (value) =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === "dev,ino,path" &&
  typeof value.path === "string" &&
  Number.isSafeInteger(value.dev) &&
  Number.isSafeInteger(value.ino) &&
  value.dev >= 0 &&
  value.ino >= 0;

const validateStartupDirectory = async (envelope) => {
  const startup = envelope.startup_cwd;
  if (
    typeof startup !== "object" ||
    startup === null ||
    Array.isArray(startup) ||
    Object.keys(startup).sort().join(",") !== "dev,ino,path,root" ||
    !isDirectoryIdentity({
      path: startup.path,
      dev: startup.dev,
      ino: startup.ino,
    }) ||
    !isDirectoryIdentity(startup.root) ||
    !Array.isArray(envelope.policy?.roots) ||
    !envelope.policy.roots.includes(startup.root.path)
  )
    throw new Error("Malformed child startup directory identity");
  const { identifyOwnedFixtureDirectory, withinOwnedFixtureRoot } =
    await import("../../dist/application/investigationSafety/OwnedFixturePolicyRuntime.js");
  if (
    !withinOwnedFixtureRoot(startup.root.path, startup.path) ||
    process.cwd() !== startup.path
  )
    throw new Error("Child startup directory is outside the sealed scope");
  for (const expected of [startup.root, startup]) {
    const current = await identifyOwnedFixtureDirectory(expected.path);
    if (current.dev !== expected.dev || current.ino !== expected.ino)
      throw new Error("Child startup directory identity changed");
  }
};

const bootstrap = async () => {
  if (process.argv.length !== 2)
    throw new Error("Fixture input belongs on the private controller pipe");
  const envelope = await readControllerData();
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    Array.isArray(envelope) ||
    Object.keys(envelope).sort().join(",") !== "arguments,policy,startup_cwd" ||
    !Array.isArray(envelope.arguments) ||
    envelope.arguments.length > 128 ||
    !envelope.arguments.every(
      (value) => typeof value === "string" && value.length <= 8192,
    )
  )
    throw new Error("Malformed controller envelope");
  const { sealOwnedFixturePolicy, attachOwnedFixturePolicy } =
    await import("../../dist/application/investigationSafety/OwnedFixturePolicy.js");
  const staticRequested =
    Array.isArray(envelope.policy?.grants) &&
    envelope.policy.grants.some(({ mode }) => mode === "owned-static");
  const controller = staticRequested
    ? (
        await import("../../dist/composition/OwnedAppleStaticSession.js")
      ).createOwnedAppleStaticSession()
    : undefined;
  const staticPortId = "controller-owned-apple-static-port";
  const token = await sealOwnedFixturePolicy(
    envelope.policy,
    controller === undefined
      ? undefined
      : {
          owned_static_ports: [
            { port_id: staticPortId, reference: controller },
          ],
        },
  );
  await validateStartupDirectory(envelope);
  const environment = Object.fromEntries(
    envelope.policy.environment.map(({ name, value }) => [name, value]),
  );
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, environment);
  const { createCli } = await import("../../dist/cli.js");
  const cli = createCli(environment, undefined, controller);
  attachOwnedFixturePolicy(cli, token, controller);
  await cli.serve(envelope.arguments);
};

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === ownedCliBootstrapPath
) {
  await bootstrap().catch(() => {
    process.stderr.write(
      "Owned fixture bootstrap refused: a valid sealed private controller policy is required.\n",
    );
    process.exitCode = 1;
  });
}
