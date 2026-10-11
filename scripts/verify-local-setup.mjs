import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";

const root = fileURLToPath(new URL("..", import.meta.url));
const launcher = join(root, "scripts/rea.mjs");
const workspace = await mkdtemp(join(tmpdir(), "rea2-local-setup-"));
const home = join(workspace, "home");
const bin = join(workspace, "bin");
const sentinel = join(workspace, "unexpected-install-or-network");
const config = join(home, ".codex/config.toml");
const registry = join(home, "Sync/skills/rea2");
const manifest =
  '---\nname: rea2\nmetadata:\n  version: "1.0.0"\n---\nSynthetic registry fixture.\n';
const original =
  'model = "synthetic-model"\n[mcp_servers.rea]\ncommand = "npx"\nargs = ["-y", "rea-agents@6.4.0", "mcp"]\n';
const require = (condition, reason) => {
  if (!condition) throw new Error(reason);
};
const environment = {
  HOME: home,
  USERPROFILE: home,
  CODEX_HOME: join(home, ".codex"),
  XDG_CONFIG_HOME: join(home, ".config"),
  PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
  REA_LOG_LEVEL: "silent",
};
const invoke = (args) => {
  const result = spawnSync(process.execPath, [launcher, ...args, "--json"], {
    cwd: workspace,
    env: environment,
    encoding: "utf8",
    timeout: 20_000,
  });
  if (result.error) throw result.error;
  if (result.stdout.trim() === "")
    throw new Error(
      `Local command produced no structured output (status ${result.status}): ${result.stderr}`,
    );
  return { status: result.status, output: JSON.parse(result.stdout) };
};
const assertUnchanged = async () => {
  require((await readFile(config, "utf8")) ===
    original, "Setup mutated a protected original configuration");
  require((await readFile(join(registry, "SKILL.md"), "utf8")) ===
    manifest, "Setup replaced the shared skill");
};
let report;
try {
  await mkdir(bin, { recursive: true });
  await mkdir(dirname(config), { recursive: true });
  await mkdir(registry, { recursive: true });
  await mkdir(join(home, ".agents/skills"), { recursive: true });
  await symlink(registry, join(home, ".agents/skills/rea2"), "dir");
  await writeFile(join(registry, "SKILL.md"), manifest);
  await writeFile(config, original);
  for (const name of ["npm", "npx", "curl"]) {
    const path = join(bin, name);
    await writeFile(
      path,
      `#!/bin/sh\nprintf forbidden > '${sentinel}'\nexit 99\n`,
    );
    await chmod(path, 0o755);
  }
  const caskroom = join(workspace, "synthetic-caskroom");
  const receipt = join(caskroom, "hopper-disassembler/.metadata/config.json");
  await mkdir(dirname(receipt), { recursive: true });
  await writeFile(
    receipt,
    JSON.stringify({ explicit: { appdir: join(workspace, "synthetic-apps") } }),
  );
  const brew = join(bin, "brew");
  await writeFile(
    brew,
    `#!/bin/sh\nif [ "$#" = 1 ] && [ "$1" = --caskroom ]; then printf '%s\\n' '${caskroom}'; exit 0; fi\nprintf forbidden > '${sentinel}'\nexit 99\n`,
  );
  await chmod(brew, 0o755);
  const plan = invoke(["setup", "--client", "codex", "--dry-run"]);
  require(plan.status === 0 &&
    plan.output.status ===
      "planned", "Local setup did not produce a read-only plan");
  require(plan.output.appliedActions.length === 0, "Dry run applied actions");
  require(plan.output.plannedActions.some(
    ({ kind }) => kind === "configure_client",
  ), "Dry run omitted local registration");
  require(!plan.output.plannedActions.some(({ kind }) =>
    /install/u.test(kind),
  ), "Dry run proposed an install");
  await assertUnchanged();
  for (const option of ["--skill", "--install-hopper"]) {
    const refused = invoke(["setup", "--client", "codex", "--yes", option]);
    require(refused.status === 1 &&
      refused.output.status ===
        "needs_human", "An unsupported installation was not refused");
    require(refused.output.appliedActions.length ===
      0, "Unsupported installation applied an action");
    await assertUnchanged();
  }
  const setup = invoke(["setup", "--client", "codex", "--yes"]);
  require(setup.status === 0 &&
    setup.output.status === "ready", "Local registration did not become ready");
  const parsed = parse(await readFile(config, "utf8"));
  require(parsed.mcp_servers.rea.command ===
    "npx", "Setup adopted the separate upstream entry");
  require(parsed.mcp_servers.rea2.command ===
    process.execPath, "Setup did not pin the current Node");
  require(JSON.stringify(parsed.mcp_servers.rea2.args) ===
    JSON.stringify([launcher, "mcp"]), "Setup did not pin this checkout");
  require((await readFile(config + ".rea.backup", "utf8")) ===
    original, "Backup did not preserve original bytes");
  const repeat = invoke(["setup", "--client", "codex", "--yes"]);
  require(repeat.status === 0 &&
    repeat.output.appliedActions.length === 0 &&
    repeat.output.plannedActions.length === 0, "Setup was not idempotent");
  const doctor = invoke(["doctor", "--client", "codex", "--skill"]);
  require(doctor.status === 0 &&
    doctor.output.identity.skill.state ===
      "aligned", "Doctor did not verify registry discovery");
  const update = invoke(["update"]);
  require(update.status === 1 &&
    update.output.status === "failed" &&
    update.output.latestVersion ===
      null, "Updater did not refuse registry effects");
  const uninstall = invoke(["uninstall"]);
  require(uninstall.status === 0 &&
    uninstall.output.status === "complete", "Uninstall did not complete");
  await assertUnchanged();
  try {
    await readFile(sentinel);
    throw new Error("A package manager or network helper ran");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  report = {
    localSetup: "verified",
    exactLauncher: true,
    additiveRegistration: true,
    backupReadback: true,
    registrySkillPreserved: true,
    engineInstall: "refused",
    bundledSkillInstall: "refused",
    automaticUpdate: "refused",
    npmNpxCurl: "not invoked",
    homebrew: "synthetic read-only discovery only",
    cleanup: "verified",
  };
} finally {
  await rm(workspace, { recursive: true, force: true });
}

process.stdout.write(JSON.stringify(report) + "\n");
