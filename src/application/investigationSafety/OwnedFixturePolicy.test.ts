import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  readFile,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyOwnedNodeFixtureScript } from "./OwnedNodeFixtureProfile.js";
import {
  ownedFixtureExecutionEnvironment,
  runOwnedFixtureExecution,
} from "./OwnedFixtureExecution.js";

import {
  admitOwnedFixtureOperation,
  attachOwnedFixturePolicy,
  digestOwnedFixtureInput,
  listOwnedFixtureOperations,
  revalidateOwnedFixturePolicy,
  registerOwnedFixtureHandlerPort,
  registerOwnedFixtureHandlerEnvironment,
  sealOwnedFixturePolicy,
  snapshotOwnedFixtureInput,
  type OwnedFixturePolicyData,
  type OwnedFixturePolicyToken,
} from "./OwnedFixturePolicy.js";

const directories: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const hash = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const nodePath = await realpath(process.execPath);
const nodeHash = createHash("sha256")
  .update(await readFile(nodePath))
  .digest("hex");
const stubPolicy = (input: unknown = {}): OwnedFixturePolicyData => ({
  roots: [],
  files: [],
  endpoints: [],
  environment: [],
  available_capabilities: ["synthetic-provider"],
  grants: [
    {
      operation: "list_procedures",
      input_digest: digestOwnedFixtureInput(input),
      capability: "synthetic-provider",
      mode: "nonexecuting-stub",
      port_id: "fixed-fake-port",
    },
  ],
});
const owned = async (
  inputFor?: (root: string, executable: string) => unknown,
) => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "rea2-sealed-owned-")),
  );
  directories.push(root);
  const executable = join(root, "owned-script.mjs");
  const source = "export const synthetic = true;\n";
  await writeFile(executable, source);
  const selectedInput = inputFor?.(root, nodePath);
  const input = {
    executable: nodePath,
    working_directory: root,
    arguments: [executable],
    ...(selectedInput as object | undefined),
  };
  const data: OwnedFixturePolicyData = {
    roots: [root],
    files: [
      { path: executable, sha256: hash(source), role: "dependency" },
      { path: nodePath, sha256: nodeHash, role: "executable" },
    ],
    endpoints: [],
    environment: [{ name: "LANG", value: "C" }],
    available_capabilities: ["owned-process"],
    grants: [
      {
        operation: "capture_process_scenario",
        input_digest: digestOwnedFixtureInput(input),
        capability: "owned-process",
        mode: "owned-files",
      },
    ],
  };
  const instance = {};
  const token = await sealOwnedFixturePolicy(data);
  registerOwnedFixtureHandlerEnvironment(instance, { LANG: "C" });
  attachOwnedFixturePolicy(instance, token);
  return { root, executable, input, data, instance, token };
};

it("does not inspect or limit inputs when no fixture policy is attached", async () => {
  let probes = 0;
  const uninspected = new Proxy(
    {},
    {
      ownKeys() {
        probes++;
        throw new Error("unexpected input probe");
      },
      getPrototypeOf() {
        probes++;
        throw new Error("unexpected prototype probe");
      },
    },
  );
  await expect(
    admitOwnedFixtureOperation({}, "list_procedures", uninspected),
  ).resolves.toBeUndefined();
  await expect(
    admitOwnedFixtureOperation({}, "trace_application_feature", {
      seed: "x".repeat(1024 * 1024 + 1),
    }),
  ).resolves.toBeUndefined();
  expect(probes).toBe(0);
});

describe("sealed controller-owned fixture admission", () => {
  it("ignores target trust hints and grants nothing without a real attached token", async () => {
    expect(
      await admitOwnedFixtureOperation({}, "capture_process_scenario", {
        trusted: true,
        NODE_ENV: "test",
        test_path: "/tmp/tests/fixture",
      }),
    ).toBeUndefined();
    expect(() =>
      attachOwnedFixturePolicy({}, {} as OwnedFixturePolicyToken),
    ).toThrow(/cannot execute/u);
  });

  it("binds an exact fake port and exact normalized operation input", async () => {
    const port = {};
    const instance = {};
    const data = stubPolicy({ document: undefined });
    const token = await sealOwnedFixturePolicy(data, {
      nonexecuting_ports: [{ port_id: "fixed-fake-port", reference: port }],
    });
    expect(() => attachOwnedFixturePolicy({}, token, {})).toThrow(
      /cannot execute/u,
    );
    registerOwnedFixtureHandlerPort(instance, port);
    attachOwnedFixturePolicy(instance, token, port);
    expect(
      (await admitOwnedFixtureOperation(instance, "list_procedures", {}))?.mode,
    ).toBe("nonexecuting-stub");
    expect(
      await admitOwnedFixtureOperation(instance, "list_procedures", {
        document: "target-chosen",
      }),
    ).toBeUndefined();
    expect(
      await admitOwnedFixtureOperation(instance, "search_procedures", {}),
    ).toBeUndefined();
    expect(() => attachOwnedFixturePolicy(instance, token, port)).toThrow(
      /cannot execute/u,
    );
    await expect(
      admitOwnedFixtureOperation(instance, "list_procedures", {}, {}),
    ).rejects.toThrow(/cannot execute/u);
  });

  it.each([
    "open_binary",
    "capture_process_scenario",
    "capture_browser_scenario",
    "inspect_binary_layout",
    "inspect_firmware_regions",
    "observe_native_calls",
  ])("never grants %s with a fake-port claim", async (operation) => {
    const data = stubPolicy();
    data.grants[0]!.operation = operation;
    await expect(
      sealOwnedFixturePolicy(data, {
        nonexecuting_ports: [{ port_id: "fixed-fake-port", reference: {} }],
      }),
    ).rejects.toThrow(/cannot execute/u);
  });

  it("rejects unknown operations, absent capabilities and replacement admission callbacks", async () => {
    const data = stubPolicy();
    data.grants[0]!.operation = "new_unknown_operation";
    await expect(sealOwnedFixturePolicy(data)).rejects.toThrow(
      /cannot execute/u,
    );
    await expect(
      sealOwnedFixturePolicy({ ...stubPolicy(), available_capabilities: [] }),
    ).rejects.toThrow(/cannot execute/u);
    await expect(
      sealOwnedFixturePolicy({ ...stubPolicy(), admission: () => undefined }),
    ).rejects.toThrow(/cannot execute/u);
  });

  it("copies and seals policy data instead of following later controller object mutations", async () => {
    const port = {};
    const instance = {};
    const data = stubPolicy();
    const token = await sealOwnedFixturePolicy(data, {
      nonexecuting_ports: [{ port_id: "fixed-fake-port", reference: port }],
    });
    registerOwnedFixtureHandlerPort(instance, port);
    attachOwnedFixturePolicy(instance, token, port);
    data.grants[0]!.operation = "capture_process_scenario";
    data.available_capabilities.length = 0;
    const inventory = listOwnedFixtureOperations(instance);
    expect(inventory[0]?.operation).toBe("list_procedures");
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(
      await admitOwnedFixtureOperation(instance, "list_procedures", {}),
    ).toBeDefined();
  });

  it("keeps protected-path checks mandatory even under an exact stub grant", async () => {
    const input = { path: "/tmp/secrets/KEYS.md" };
    const port = {};
    const instance = {};
    const token = await sealOwnedFixturePolicy(stubPolicy(input), {
      nonexecuting_ports: [{ port_id: "fixed-fake-port", reference: port }],
    });
    registerOwnedFixtureHandlerPort(instance, port);
    attachOwnedFixturePolicy(instance, token, port);
    await expect(
      admitOwnedFixtureOperation(instance, "list_procedures", input),
    ).rejects.toThrow(/protected/iu);
    expect(
      await admitOwnedFixtureOperation({}, "list_procedures", input),
    ).toBeUndefined();
  });

  it("never hashes executable input getters, hooks or cyclic/oversized data", () => {
    let calls = 0;
    const accessor = Object.defineProperty({}, "path", {
      enumerable: true,
      get() {
        calls++;
        return "/tmp";
      },
    });
    expect(() => digestOwnedFixtureInput(accessor)).toThrow(/cannot execute/u);
    expect(calls).toBe(0);
    expect(() =>
      digestOwnedFixtureInput({
        toJSON() {
          calls++;
          return {};
        },
      }),
    ).toThrow(/cannot execute/u);
    expect(calls).toBe(0);
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => digestOwnedFixtureInput(cycle)).toThrow(/cannot execute/u);
    expect(() =>
      digestOwnedFixtureInput({ value: "a".repeat(1024 * 1024 + 1) }),
    ).toThrow(/cannot execute/u);
  });
});

describe("sealed owned file and runtime bounds", () => {
  it("revalidates controller-seeded bytes before admitting dispatch", async () => {
    const fixture = await owned();
    const admission = await admitOwnedFixtureOperation(
      fixture.instance,
      "capture_process_scenario",
      fixture.input,
    );
    expect(admission?.environment).toEqual({ LANG: "C" });
    expect(Object.isFrozen(admission?.environment)).toBe(true);
    await writeFile(fixture.executable, "export const synthetic = false;\n");
    await expect(
      admitOwnedFixtureOperation(
        fixture.instance,
        "capture_process_scenario",
        fixture.input,
      ),
    ).rejects.toThrow(/cannot execute/u);
  });

  it("rejects replacement inode even with the originally sealed bytes", async () => {
    const fixture = await owned();
    const replacement = join(fixture.root, "replacement.mjs");
    await writeFile(replacement, "export const synthetic = true;\n");
    await rename(replacement, fixture.executable);
    await expect(
      revalidateOwnedFixturePolicy(fixture.instance),
    ).rejects.toThrow(/cannot execute/u);
  });

  it("rejects hardlink aliases added after sealing", async () => {
    const fixture = await owned();
    await link(fixture.executable, join(fixture.root, "alias.mjs"));
    await expect(
      revalidateOwnedFixturePolicy(fixture.instance),
    ).rejects.toThrow(/cannot execute/u);
  });

  it("rejects symlink and hardlink seeds at sealing", async () => {
    const fixture = await owned();
    const alias = join(fixture.root, "alias.mjs");
    await symlink(fixture.executable, alias);
    await expect(
      sealOwnedFixturePolicy({
        ...fixture.data,
        files: [{ ...fixture.data.files[0], path: alias }],
      }),
    ).rejects.toThrow(/cannot execute/u);
    await rm(alias);
    await link(fixture.executable, alias);
    await expect(sealOwnedFixturePolicy(fixture.data)).rejects.toThrow(
      /cannot execute/u,
    );
  });

  it("does not let newly created files inside a root acquire execution authority", async () => {
    const fixture = await owned((root) => ({
      executable_path: join(root, "later.mjs"),
    }));
    await writeFile(
      join(fixture.root, "later.mjs"),
      "export const unseeded = true;",
    );
    await expect(
      admitOwnedFixtureOperation(
        fixture.instance,
        "capture_process_scenario",
        fixture.input,
      ),
    ).rejects.toThrow(/cannot execute/u);
  });

  it("requires dependency/scenario paths to remain within an owned root", async () => {
    const fixture = await owned();
    await expect(
      sealOwnedFixturePolicy({
        ...fixture.data,
        roots: [],
        files: [{ ...fixture.data.files[0], role: "dependency" }],
      }),
    ).rejects.toThrow(/cannot execute/u);
  });

  it.each([
    "http://localhost:1234/",
    "http://127.0.0.1/",
    "https://127.0.0.1:1234/",
    "http://127.0.0.1:1234/#redirect",
    "http://user:pass@127.0.0.1:1234/",
  ])("rejects nonexact loopback endpoint %s", async (endpoint) => {
    const fixture = await owned();
    await expect(
      sealOwnedFixturePolicy({ ...fixture.data, endpoints: [endpoint] }),
    ).rejects.toThrow(/cannot execute/u);
  });

  it("requires an actually bound controller listener and revalidates it", async () => {
    const fixture = await owned();
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw Error("Missing listener");
    const url = `http://127.0.0.1:${address.port}/`;
    await expect(
      sealOwnedFixturePolicy({ ...fixture.data, endpoints: [url] }),
    ).rejects.toThrow(/cannot execute/u);
    const instance = {};
    const token = await sealOwnedFixturePolicy(
      { ...fixture.data, endpoints: [url] },
      { loopback_endpoints: [{ url, server }] },
    );
    registerOwnedFixtureHandlerEnvironment(instance, { LANG: "C" });
    attachOwnedFixturePolicy(instance, token);
    expect(
      await admitOwnedFixtureOperation(
        instance,
        "capture_process_scenario",
        fixture.input,
      ),
    ).toBeDefined();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.splice(servers.indexOf(server), 1);
    await expect(revalidateOwnedFixturePolicy(instance)).rejects.toThrow(
      /cannot execute/u,
    );
  });
});

describe("owned fixture environment", () => {
  it("ignores ambient fallback credentials outside scoped execution and uses only the admitted map inside", async () => {
    const fallback = { SYNTHETIC_SECRET: "do-not-forward", PATH: "/unowned" };
    const outside = ownedFixtureExecutionEnvironment(fallback);
    expect(outside).toEqual({});
    expect(Object.isFrozen(outside)).toBe(true);
    const fixture = await owned();
    const admission = await admitOwnedFixtureOperation(
      fixture.instance,
      "capture_process_scenario",
      fixture.input,
    );
    const inside = runOwnedFixtureExecution(admission, () =>
      ownedFixtureExecutionEnvironment(fallback),
    );
    expect(inside).toEqual({ LANG: "C" });
    expect(ownedFixtureExecutionEnvironment(fallback)).toEqual({});
  });
  it("rejects credential-bearing environment names rather than inheriting process.env", async () => {
    const fixture = await owned();
    await expect(
      sealOwnedFixturePolicy({
        ...fixture.data,
        environment: [{ name: "API_TOKEN", value: "synthetic" }],
      }),
    ).rejects.toThrow(/cannot execute/u);
    const admission = await admitOwnedFixtureOperation(
      fixture.instance,
      "capture_process_scenario",
      fixture.input,
    );
    expect(Object.keys(admission?.environment ?? {})).toEqual(["LANG"]);
  });

  it.each([
    "NODE_OPTIONS",
    "NODE_PATH",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "DYLD_INSERT_LIBRARIES",
    "PYTHONPATH",
    "BASH_ENV",
    "JAVA_TOOL_OPTIONS",
  ])("rejects loader and hook environment injection %s", async (name) => {
    const fixture = await owned();
    await expect(
      sealOwnedFixturePolicy({
        ...fixture.data,
        environment: [{ name, value: "synthetic" }],
      }),
    ).rejects.toThrow(/cannot execute/u);
  });
});

describe("actual factory and process scenario binding", () => {
  it("rejects attachment to a different registered factory port", async () => {
    const instance = {};
    const claimedFake = {};
    const actualHandler = {};
    const token = await sealOwnedFixturePolicy(stubPolicy(), {
      nonexecuting_ports: [
        { port_id: "fixed-fake-port", reference: claimedFake },
      ],
    });
    registerOwnedFixtureHandlerPort(instance, actualHandler);
    expect(() =>
      attachOwnedFixturePolicy(instance, token, claimedFake),
    ).toThrow(/cannot execute/u);
  });

  it("requires the factory's selected environment to match before attachment", async () => {
    const fixture = await owned();
    const instance = {};
    registerOwnedFixtureHandlerEnvironment(instance, { LANG: "different" });
    expect(() => attachOwnedFixturePolicy(instance, fixture.token)).toThrow(
      /cannot execute/u,
    );
    expect(() =>
      registerOwnedFixtureHandlerEnvironment(instance, { LANG: "C" }),
    ).toThrow(/cannot execute/u);
  });

  it("rejects additional ambient factory environment entries omitted from the sealed map", async () => {
    const fixture = await owned();
    const instance = {};
    registerOwnedFixtureHandlerEnvironment(instance, {
      LANG: "C",
      UNDECLARED_URL: "http://127.0.0.1:49191/",
    });
    expect(() => attachOwnedFixturePolicy(instance, fixture.token)).toThrow(
      /cannot execute/u,
    );
  });

  it.each(["node", "/unseeded/interpreter"])(
    "rejects an unrelated process executable %s",
    async (executable) => {
      const fixture = await owned((root) => ({
        executable,
        working_directory: root,
      }));
      await expect(
        admitOwnedFixtureOperation(
          fixture.instance,
          "capture_process_scenario",
          fixture.input,
        ),
      ).rejects.toThrow(/cannot execute/u);
    },
  );

  it("rejects a process scenario loader environment even when the outer digest is exact", async () => {
    const fixture = await owned((root, executable) => ({
      executable,
      working_directory: root,
      environment: { NODE_OPTIONS: "--require=untrusted" },
    }));
    await expect(
      admitOwnedFixtureOperation(
        fixture.instance,
        "capture_process_scenario",
        fixture.input,
      ),
    ).rejects.toThrow(/cannot execute/u);
  });

  it("rejects an unseeded argv dependency created after policy sealing", async () => {
    const fixture = await owned((root, executable) => ({
      executable,
      working_directory: root,
      arguments: ["later-dependency.mjs"],
    }));
    await writeFile(
      join(fixture.root, "later-dependency.mjs"),
      "export const unseeded=true;",
    );
    await expect(
      admitOwnedFixtureOperation(
        fixture.instance,
        "capture_process_scenario",
        fixture.input,
      ),
    ).rejects.toThrow(/cannot execute/u);
  });

  it("rejects a newly created argv symlink even when it points to a sealed executable", async () => {
    const fixture = await owned((root, executable) => ({
      executable,
      working_directory: root,
      arguments: ["alias.mjs"],
    }));
    await symlink(fixture.executable, join(fixture.root, "alias.mjs"));
    await expect(
      admitOwnedFixtureOperation(
        fixture.instance,
        "capture_process_scenario",
        fixture.input,
      ),
    ).rejects.toThrow(/cannot execute/u);
  });

  it.each([
    "--require=/unseeded/hook.js",
    "--import=file:///unseeded/hook.js",
    "--env-file=/unseeded/env",
    "file:///unseeded/input",
  ])("keeps unbound loader argv %s unavailable", async (argument) => {
    const fixture = await owned((root, executable) => ({
      executable,
      working_directory: root,
      arguments: [argument],
    }));
    await expect(
      admitOwnedFixtureOperation(
        fixture.instance,
        "capture_process_scenario",
        fixture.input,
      ),
    ).rejects.toThrow(/cannot execute/u);
  });
});

describe("sealed CLI scenario contents", () => {
  it("reads only the hashed controller-seeded CLI scenario and verifies its inner command", async () => {
    const fixture = await owned();
    const path = join(fixture.root, "scenario.json");
    const bytes = JSON.stringify({
      executable: nodePath,
      working_directory: fixture.root,
      arguments: [fixture.executable],
    });
    await writeFile(path, bytes);
    const input = { args: { scenario: path }, options: {} };
    const data = {
      ...fixture.data,
      files: [
        ...fixture.data.files,
        { path, sha256: hash(bytes), role: "scenario" as const },
      ],
      grants: [
        {
          ...fixture.data.grants[0]!,
          operation: "capture-process",
          input_digest: digestOwnedFixtureInput(input),
        },
      ],
    };
    const instance = {};
    const token = await sealOwnedFixturePolicy(data);
    registerOwnedFixtureHandlerEnvironment(instance, { LANG: "C" });
    attachOwnedFixturePolicy(instance, token);
    expect(
      await admitOwnedFixtureOperation(instance, "capture-process", input),
    ).toBeDefined();
    await writeFile(
      path,
      JSON.stringify({
        executable: "/unseeded/program",
        working_directory: fixture.root,
      }),
    );
    await expect(
      admitOwnedFixtureOperation(instance, "capture-process", input),
    ).rejects.toThrow(/cannot execute/u);
  });

  it("never grants unrelated known operations merely because one executable was seeded", async () => {
    const fixture = await owned();
    await expect(
      sealOwnedFixturePolicy({
        ...fixture.data,
        grants: [{ ...fixture.data.grants[0]!, operation: "inspect_macho" }],
      }),
    ).rejects.toThrow(/cannot execute/u);
  });
});

describe("independent review boundary regressions", () => {
  it("returns a recursively frozen bounded snapshot detached from original arrays and records", () => {
    const original = { args: { arguments: ["seeded"] }, options: { limit: 1 } };
    const snapshot = snapshotOwnedFixtureInput(original);
    original.args.arguments[0] = "changed";
    original.options.limit = 99;
    expect(snapshot).toEqual({
      args: { arguments: ["seeded"] },
      options: { limit: 1 },
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.args)).toBe(true);
    expect(Object.isFrozen(snapshot.args.arguments)).toBe(true);
    expect(() => snapshot.args.arguments.push("changed")).toThrow();
  });

  it("admits the original bounded snapshot despite caller mutation during awaits", async () => {
    const fixture = await owned();
    const input = fixture.input as {
      executable: string;
      working_directory: string;
    };
    const pending = admitOwnedFixtureOperation(
      fixture.instance,
      "capture_process_scenario",
      input,
    );
    input.executable = "/unsealed/changed-program";
    await expect(pending).resolves.toBeDefined();
  });

  it("rejects a working directory reached through an owned-root symlink", async () => {
    const fixture = await owned((root, executable) => ({
      executable,
      working_directory: join(root, "alias"),
    }));
    const outside = await realpath(
      await mkdtemp(join(tmpdir(), "rea2-external-cwd-")),
    );
    directories.push(outside);
    await symlink(outside, join(fixture.root, "alias"));
    await expect(
      admitOwnedFixtureOperation(
        fixture.instance,
        "capture_process_scenario",
        fixture.input,
      ),
    ).rejects.toThrow(/cannot execute/u);
  });

  it("rejects a symlinked working-directory ancestor and replacement directory identity", async () => {
    const fixture = await owned((root) => ({
      working_directory: join(root, "cwd"),
    }));
    const cwd = join(fixture.root, "cwd");
    await mkdir(cwd);
    await expect(
      admitOwnedFixtureOperation(
        fixture.instance,
        "capture_process_scenario",
        fixture.input,
      ),
    ).resolves.toBeDefined();
    await rename(cwd, join(fixture.root, "old-cwd"));
    await mkdir(cwd);
    await expect(
      revalidateOwnedFixturePolicy(fixture.instance),
    ).rejects.toThrow(/cannot execute/u);

    const other = await owned((root) => ({
      working_directory: join(root, "alias", "child"),
    }));
    await mkdir(join(other.root, "real", "child"), { recursive: true });
    await symlink(join(other.root, "real"), join(other.root, "alias"));
    await expect(
      admitOwnedFixtureOperation(
        other.instance,
        "capture_process_scenario",
        other.input,
      ),
    ).rejects.toThrow(/cannot execute/u);
  });

  it("refuses another sealed interpreter at policy creation", async () => {
    const fixture = await owned();
    await expect(
      sealOwnedFixturePolicy({
        ...fixture.data,
        files: [
          {
            path: fixture.executable,
            sha256: hash("export const synthetic = true;\n"),
            role: "executable",
          },
        ],
      }),
    ).rejects.toThrow(/cannot execute/u);
  });
});

describe("typed owned observation authority", () => {
  it("rejects relative observation files outside the bound working-directory roots", async () => {
    const fixture = await owned(() => ({
      filesystem_observation_paths: ["../outside/unsealed.txt"],
    }));
    await expect(
      admitOwnedFixtureOperation(
        fixture.instance,
        "capture_process_scenario",
        fixture.input,
      ),
    ).rejects.toThrow(/cannot execute/u);
  });

  it.each(["unlisted", "hardlinked", "protected-name"])(
    "rejects recursive observation directories containing %s descendants",
    async (kind) => {
      const fixture = await owned((root) => ({
        filesystem_observation_paths: [join(root, "observed")],
      }));
      const observed = join(fixture.root, "observed");
      await mkdir(observed);
      if (kind === "hardlinked") {
        const unsealed = join(fixture.root, "unsealed.txt");
        await writeFile(unsealed, "SYNTHETIC_ONLY");
        await link(unsealed, join(observed, "alias.txt"));
      } else if (kind === "protected-name") {
        await mkdir(join(observed, "secrets"));
        await writeFile(
          join(observed, "secrets", "KEYS.md"),
          "SYNTHETIC_NOT_A_SECRET",
        );
      } else await writeFile(join(observed, "unlisted.txt"), "SYNTHETIC_ONLY");
      await expect(
        admitOwnedFixtureOperation(
          fixture.instance,
          "capture_process_scenario",
          fixture.input,
        ),
      ).rejects.toThrow(/cannot execute/u);
    },
  );

  it.each([
    "HTTP://invalid.example/resource",
    "FiLe:///unbound/file",
    "javascript:alert(1)",
    "custom:opaque",
  ])(
    "rejects unsupported URI scheme in an observation selector %s",
    async (value) => {
      const fixture = await owned(() => ({
        filesystem_observation_paths: [value],
      }));
      await expect(
        admitOwnedFixtureOperation(
          fixture.instance,
          "capture_process_scenario",
          fixture.input,
        ),
      ).rejects.toThrow(/cannot execute/u);
    },
  );

  it("resolves a relative sealed regular observation file under the bound cwd", async () => {
    const fixture = await owned(() => ({
      filesystem_observation_paths: ["owned-script.mjs"],
    }));
    await expect(
      admitOwnedFixtureOperation(
        fixture.instance,
        "capture_process_scenario",
        fixture.input,
      ),
    ).resolves.toBeDefined();
  });

  it("rejects direct unsealed and protected observation files and hardlinked sealed files", async () => {
    const unsealed = await owned((root) => ({
      filesystem_observation_paths: [join(root, "unsealed.txt")],
    }));
    await writeFile(join(unsealed.root, "unsealed.txt"), "SYNTHETIC_ONLY");
    await expect(
      admitOwnedFixtureOperation(
        unsealed.instance,
        "capture_process_scenario",
        unsealed.input,
      ),
    ).rejects.toThrow(/cannot execute/u);
    const protectedFile = await owned((root) => ({
      filesystem_observation_paths: [join(root, "secrets", "KEYS.md")],
    }));
    await expect(
      admitOwnedFixtureOperation(
        protectedFile.instance,
        "capture_process_scenario",
        protectedFile.input,
      ),
    ).rejects.toThrow(/protected|cannot execute/u);
    const hardlinked = await owned(() => ({
      filesystem_observation_paths: ["owned-script.mjs"],
    }));
    await link(hardlinked.executable, join(hardlinked.root, "alias.mjs"));
    await expect(
      admitOwnedFixtureOperation(
        hardlinked.instance,
        "capture_process_scenario",
        hardlinked.input,
      ),
    ).rejects.toThrow(/protected|cannot execute/u);
  });

  it("retains URI and path-looking stdin and normalization strings as data", async () => {
    const fixture = await owned(() => ({
      events: [
        {
          type: "input",
          at_ms: 0,
          data: "http://invalid.example/resource file:///unbound/path ../../.ssh/id_rsa",
        },
      ],
      normalization: {
        patterns: [
          {
            pattern: "HTTP://invalid.example/resource",
            replacement: "/unbound/docs",
          },
          { pattern: "javascript:opaque", replacement: "file:///unbound/file" },
        ],
      },
    }));
    await expect(
      admitOwnedFixtureOperation(
        fixture.instance,
        "capture_process_scenario",
        fixture.input,
      ),
    ).resolves.toBeDefined();
  });
});

describe("independent closure identifier and startup regressions", () => {
  it("allows inert property names and local data without treating them as executable globals", () => {
    expect(() =>
      verifyOwnedNodeFixtureScript(
        'const sample = {eval: true}; process.stdout.write(String(Object.hasOwn(sample, "eval")));',
      ),
    ).not.toThrow();
  });
  it.each([
    'const alias = eval; String("inert");',
    'const alias = Function; String("inert");',
    'const alias = globalThis; String("inert");',
    'const Object = {hasOwn: eval}; Object.hasOwn("hidden code");',
    "const process = JSON; String(process);",
    "const sample = {eval}; String(sample);",
  ])(
    "rejects executable global aliases and approved-global shadowing %s",
    async (source) => {
      const fixture = await owned();
      await writeFile(fixture.executable, source);
      const data = {
        ...fixture.data,
        files: fixture.data.files.map((file) =>
          file.path === fixture.executable
            ? { ...file, sha256: hash(source) }
            : file,
        ),
      };
      const token = await sealOwnedFixturePolicy(data);
      const instance = {};
      registerOwnedFixtureHandlerEnvironment(instance, { LANG: "C" });
      attachOwnedFixturePolicy(instance, token);
      await expect(
        admitOwnedFixtureOperation(
          instance,
          "capture_process_scenario",
          fixture.input,
        ),
      ).rejects.toThrow(/cannot execute/u);
    },
  );

  it.each([
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "GIO_EXTRA_MODULES",
    "UV_THREADPOOL_SIZE",
    "UNREVIEWED_CONFIG",
  ])("rejects unsupported startup environment name %s", async (name) => {
    const fixture = await owned();
    await expect(
      sealOwnedFixturePolicy({
        ...fixture.data,
        environment: [{ name, value: "inert-relative-value" }],
      }),
    ).rejects.toThrow(/cannot execute/u);
  });

  it("rejects an approved call name aliased to eval without executing the source", async () => {
    const fixture = await owned();
    const source =
      "const String = eval; String(\"import('node:fs').then(fs => process.stdout.write(fs.readFileSync('/etc/hosts','utf8')))\");";
    await writeFile(fixture.executable, source);
    const data = {
      ...fixture.data,
      files: fixture.data.files.map((file) =>
        file.path === fixture.executable
          ? { ...file, sha256: hash(source) }
          : file,
      ),
    };
    const token = await sealOwnedFixturePolicy(data);
    const instance = {};
    registerOwnedFixtureHandlerEnvironment(instance, { LANG: "C" });
    attachOwnedFixturePolicy(instance, token);
    await expect(
      admitOwnedFixtureOperation(
        instance,
        "capture_process_scenario",
        fixture.input,
      ),
    ).rejects.toThrow(/cannot execute/u);
  });

  it("rejects OpenSSL startup configuration before spawning Node", async () => {
    const fixture = await owned();
    await writeFile(
      join(fixture.root, "openssl.cnf"),
      ".include /unsealed/config\n",
    );
    await expect(
      sealOwnedFixturePolicy({
        ...fixture.data,
        environment: [{ name: "OPENSSL_CONF", value: "openssl.cnf" }],
      }),
    ).rejects.toThrow(/cannot execute/u);
  });
});

describe("owned Node script and environment profile", () => {
  it.each([
    "--flag=/outside",
    "data:text/javascript,1+1",
    "relative\n/outside",
    "../outside",
    "/outside/missing",
  ])(
    "rejects unsupported data argument after the valid script %s",
    async (argument) => {
      const fixture = await owned((root) => ({
        arguments: [join(root, "owned-script.mjs"), argument],
      }));
      await expect(
        admitOwnedFixtureOperation(
          fixture.instance,
          "capture_process_scenario",
          fixture.input,
        ),
      ).rejects.toThrow(/cannot execute/u);
    },
  );

  it.each([
    'import "./unlisted.mjs";',
    'import "node:module";',
    'import("./unlisted.mjs");',
    'export * from "./unlisted.mjs";',
    'require("./unlisted.mjs");',
    'eval("1+1");',
    'process.getBuiltinModule("module");',
    'String.constructor("return process")();',
  ])("refuses script loading/inline execution surface %s", async (source) => {
    const fixture = await owned();
    await writeFile(fixture.executable, source);
    const data = {
      ...fixture.data,
      files: fixture.data.files.map((file) =>
        file.path === fixture.executable
          ? { ...file, sha256: hash(source) }
          : file,
      ),
    };
    const token = await sealOwnedFixturePolicy(data);
    const instance = {};
    registerOwnedFixtureHandlerEnvironment(instance, { LANG: "C" });
    attachOwnedFixturePolicy(instance, token);
    await expect(
      admitOwnedFixtureOperation(
        instance,
        "capture_process_scenario",
        fixture.input,
      ),
    ).rejects.toThrow(/cannot execute/u);
  });

  it("admits the actual builtin-free stdout fixture profile", async () => {
    const fixture = await owned();
    const source =
      'process.stdout.write("OWNED_FIXTURE_OK;ambient=" + String(Object.hasOwn(process.env, "REA2_SYNTHETIC_SECRET")) + "\\n");';
    await writeFile(fixture.executable, source);
    const data = {
      ...fixture.data,
      files: fixture.data.files.map((file) =>
        file.path === fixture.executable
          ? { ...file, sha256: hash(source) }
          : file,
      ),
    };
    const instance = {};
    const token = await sealOwnedFixturePolicy(data);
    registerOwnedFixtureHandlerEnvironment(instance, { LANG: "C" });
    attachOwnedFixturePolicy(instance, token);
    await expect(
      admitOwnedFixtureOperation(
        instance,
        "capture_process_scenario",
        fixture.input,
      ),
    ).resolves.toBeDefined();
  });

  it("binds an isolated HOME directory and rejects its later replacement", async () => {
    const fixture = await owned();
    const home = join(fixture.root, "home");
    await mkdir(home);
    const environment = [
      { name: "LANG", value: "C" },
      { name: "HOME", value: home },
    ];
    const token = await sealOwnedFixturePolicy({
      ...fixture.data,
      environment,
    });
    const instance = {};
    registerOwnedFixtureHandlerEnvironment(instance, { LANG: "C", HOME: home });
    attachOwnedFixturePolicy(instance, token);
    await expect(
      admitOwnedFixtureOperation(
        instance,
        "capture_process_scenario",
        fixture.input,
      ),
    ).resolves.toBeDefined();
    await rename(home, join(fixture.root, "old-home"));
    await mkdir(home);
    await expect(revalidateOwnedFixturePolicy(instance)).rejects.toThrow(
      /cannot execute/u,
    );
  });

  it.each([
    "-e",
    "--eval",
    "-p",
    "--print",
    "-c",
    "--check",
    "-m",
    "--input-type=module",
    "--flag=/outside",
    "data:text/javascript,1+1",
    "relative\n/outside",
  ])("rejects inline/module/config execution option %s", async (option) => {
    const fixture = await owned((root, executable) => ({
      executable,
      working_directory: root,
      arguments: [option, "1+1"],
    }));
    await expect(
      admitOwnedFixtureOperation(
        fixture.instance,
        "capture_process_scenario",
        fixture.input,
      ),
    ).rejects.toThrow(/cannot execute/u);
  });

  it.each([
    { name: "SERVICE_URL", value: "http://127.0.0.1:49191/" },
    { name: "HOME", value: "/unowned/config-home" },
    { name: "XDG_CONFIG_HOME", value: "/unowned/config" },
    { name: "PATH", value: "/usr/bin:/bin" },
  ])(
    "rejects an unbound complete factory environment value $name",
    async (entry) => {
      const fixture = await owned();
      await expect(
        sealOwnedFixturePolicy({ ...fixture.data, environment: [entry] }),
      ).rejects.toThrow(/cannot execute/u);
    },
  );
});
