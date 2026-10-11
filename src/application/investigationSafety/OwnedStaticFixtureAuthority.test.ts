import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createOwnedAppleStaticSession } from "../binary/OwnedAppleStaticSession.js";
import { machoImage } from "../../artifacts/apple/MachoImage.fixture.js";
import { runOwnedFixtureExecution } from "./OwnedFixtureExecution.js";
import {
  admitOwnedFixtureOperation,
  attachOwnedFixturePolicy,
  digestOwnedFixtureInput,
  registerOwnedFixtureHandlerEnvironment,
  registerOwnedFixtureHandlerPort,
  sealOwnedFixturePolicy,
} from "./OwnedFixturePolicy.js";
import {
  requireOwnedStaticFixtureInventory,
  requireOwnedStaticFixtureOpen,
  sealOwnedStaticFixtureInventory,
  withBoundedOwnedStaticFixtureInventory,
  withOwnedStaticFixtureInventory,
} from "./OwnedStaticFixtureInventory.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await fs.rm(root, { recursive: true, force: true });
});
const fixture = async () => {
  const root = await fs.realpath(
    await fs.mkdtemp(join(tmpdir(), "rea-static-authority-")),
  );
  roots.push(root);
  const primary = join(root, "primary");
  const dependency = join(root, "dependency");
  await fs.writeFile(primary, "owned");
  await fs.writeFile(dependency, "owned");
  const data = {
    roots: [root],
    directories: [] as string[],
    files: [primary, dependency].map((path) => ({
      path,
      sha256: createHash("sha256").update("owned").digest("hex"),
    })),
  };
  return {
    primary,
    dependency,
    data,
    token: await sealOwnedStaticFixtureInventory(data),
  };
};
it("plain artifact scopes cannot open a listed target or dispatch another operation", async () => {
  const { primary, token } = await fixture();
  const owner = {};
  withOwnedStaticFixtureInventory(token, owner, "inspect_keyed_archive", () => {
    expect(() =>
      requireOwnedStaticFixtureInventory(owner, "open_binary"),
    ).toThrow();
    expect(() =>
      requireOwnedStaticFixtureInventory(owner, "decode_interface_builder"),
    ).toThrow();
    expect(() => requireOwnedStaticFixtureOpen(owner, primary)).toThrow();
  });
});
it.each(["open_binary", "inspect_keyed_archive"])(
  "%s exact binding permits only its primary path",
  async (operation) => {
    const { primary, dependency, token } = await fixture();
    const owner = {};
    const input_digest = digestOwnedFixtureInput({ path: primary });
    withBoundedOwnedStaticFixtureInventory(token, owner, operation, {
      input_digest,
      open_binding: {
        primary_path: primary,
        input_digest,
        kind: operation === "open_binary" ? "direct-open" : "cli-stage",
      },
      run: () => {
        expect(requireOwnedStaticFixtureOpen(owner, primary)).toBe(token);
        expect(() =>
          requireOwnedStaticFixtureOpen(owner, dependency),
        ).toThrow();
        expect(() => requireOwnedStaticFixtureOpen({}, primary)).toThrow();
        expect(() =>
          requireOwnedStaticFixtureInventory(owner, "trace_dylib_resolution"),
        ).toThrow();
      },
    });
  },
);
it("rejects a stage whose digest or kind does not match the selected request", async () => {
  const { primary, token } = await fixture();
  const input_digest = digestOwnedFixtureInput({ path: primary });
  expect(() =>
    withBoundedOwnedStaticFixtureInventory(token, {}, "inspect_keyed_archive", {
      input_digest,
      open_binding: {
        primary_path: primary,
        input_digest: digestOwnedFixtureInput({ path: "different" }),
        kind: "cli-stage",
      },
      run: () => undefined,
    }),
  ).toThrow();
  expect(() =>
    withBoundedOwnedStaticFixtureInventory(token, {}, "inspect_keyed_archive", {
      input_digest,
      open_binding: {
        primary_path: primary,
        input_digest,
        kind: "direct-open",
      },
      run: () => undefined,
    }),
  ).toThrow();
});
it("copies the controller binding so later mutations cannot select a dependency", async () => {
  const { primary, dependency, token } = await fixture();
  const owner = {};
  const input_digest = digestOwnedFixtureInput({ path: primary });
  const open_binding = {
    primary_path: primary,
    input_digest,
    kind: "cli-stage" as const,
  };
  await withBoundedOwnedStaticFixtureInventory(
    token,
    owner,
    "inspect_keyed_archive",
    {
      input_digest,
      open_binding,
      run: async () => {
        open_binding.primary_path = dependency;
        await Promise.resolve();
        expect(requireOwnedStaticFixtureOpen(owner, primary)).toBe(token);
        expect(() =>
          requireOwnedStaticFixtureOpen(owner, dependency),
        ).toThrow();
      },
    },
  );
});
it.each(["mcp", "cli"] as const)(
  "policy derives %s open authority from the exact frozen input",
  async (transport) => {
    const { primary, dependency, data } = await fixture();
    const port = createOwnedAppleStaticSession();
    const owner = {};
    registerOwnedFixtureHandlerPort(owner, port);
    registerOwnedFixtureHandlerEnvironment(owner, {});
    const input =
      transport === "mcp"
        ? {}
        : {
            args: { path: primary, archive: "." },
            options: { offset: 0, limit: 20000 },
          };
    const operation = "inspect_keyed_archive";
    const token = await sealOwnedFixturePolicy(
      {
        roots: data.roots,
        files: data.files.map((file) => ({ ...file, role: "dependency" })),
        static_inventory: { directories: [] },
        environment: [],
        endpoints: [],
        available_capabilities: ["static"],
        grants: [
          {
            operation,
            input_digest: digestOwnedFixtureInput(input),
            capability: "static",
            mode: "owned-static",
            port_id: "static-port",
          },
        ],
      },
      { owned_static_ports: [{ port_id: "static-port", reference: port }] },
    );
    attachOwnedFixturePolicy(owner, token, port);
    const admission = await admitOwnedFixtureOperation(
      owner,
      operation,
      input,
      port,
    );
    runOwnedFixtureExecution(admission, () => {
      expect(requireOwnedStaticFixtureInventory(port, operation)).toBe(
        admission?.static_inventory,
      );
      expect(() =>
        requireOwnedStaticFixtureInventory(port, "open_binary"),
      ).toThrow();
      if (transport === "cli")
        expect(requireOwnedStaticFixtureOpen(port, primary)).toBe(
          admission?.static_inventory,
        );
      else expect(() => requireOwnedStaticFixtureOpen(port, primary)).toThrow();
      expect(() => requireOwnedStaticFixtureOpen(port, dependency)).toThrow();
    });
  },
);

it("opens a sealed flat iOS bundle while optional Contents metadata stays absent", async () => {
  const { data } = await fixture();
  const app = join(data.roots[0]!, "Flat.app");
  await fs.mkdir(app);
  const info = join(app, "Info.plist");
  const executable = join(app, "App");
  const infoBytes = Buffer.from(
    "<plist><dict><key>CFBundleExecutable</key><string>App</string></dict></plist>",
  );
  const imageBytes = Buffer.from(machoImage({}));
  await fs.writeFile(info, infoBytes);
  await fs.writeFile(executable, imageBytes);
  data.directories.push(app);
  data.files.push(
    ...[
      [info, infoBytes],
      [executable, imageBytes],
    ].map(([path, bytes]) => ({
      path: path as string,
      sha256: createHash("sha256")
        .update(bytes as Buffer)
        .digest("hex"),
    })),
  );
  const token = await sealOwnedStaticFixtureInventory(data);
  const owner = createOwnedAppleStaticSession();
  const input_digest = digestOwnedFixtureInput({ path: app });
  const result = await withBoundedOwnedStaticFixtureInventory(
    token,
    owner,
    "open_binary",
    {
      input_digest,
      open_binding: { primary_path: app, input_digest, kind: "direct-open" },
      run: () => owner.open(app),
    },
  );
  expect(result.ok).toBe(true);
  expect(owner.activeTarget()?.path).toBe(executable);
  await owner.close();
});
