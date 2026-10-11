import * as fs from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { createOwnedAppleStaticSession } from "../../../src/application/binary/OwnedAppleStaticSession.js";
import {
  admitOwnedFixtureOperation,
  attachOwnedFixturePolicy,
  digestOwnedFixtureInput,
  registerOwnedFixtureHandlerEnvironment,
  registerOwnedFixtureHandlerPort,
  sealOwnedFixturePolicy,
} from "../../../src/application/investigationSafety/OwnedFixturePolicy.js";
import { createHash } from "node:crypto";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: vi.fn(actual.realpath),
    lstat: vi.fn(actual.lstat),
  };
});
it("unowned and unmatched requests perform no path probes; matching stub protection still probes", async () => {
  const root = await createTestTempDirectory("rea-admission-order-");
  const path = join(root, "owned");
  await fs.writeFile(path, "owned");
  const input = { path };
  const port = { execute: async () => undefined };
  const owner = {};
  registerOwnedFixtureHandlerPort(owner, port);
  const token = await sealOwnedFixturePolicy(
    {
      roots: [],
      files: [],
      environment: [],
      endpoints: [],
      available_capabilities: ["stub"],
      grants: [
        {
          operation: "address_name",
          input_digest: digestOwnedFixtureInput(input),
          capability: "stub",
          mode: "nonexecuting-stub",
          port_id: "stub",
        },
      ],
    },
    { nonexecuting_ports: [{ port_id: "stub", reference: port }] },
  );
  attachOwnedFixturePolicy(owner, token, port);
  vi.clearAllMocks();
  expect(
    await admitOwnedFixtureOperation({}, "open_binary", input),
  ).toBeUndefined();
  expect(
    await admitOwnedFixtureOperation(owner, "address_name", {
      path: join(root, "unmatched"),
    }),
  ).toBeUndefined();
  expect(fs.realpath).not.toHaveBeenCalled();
  expect(fs.lstat).not.toHaveBeenCalled();
  expect(
    await admitOwnedFixtureOperation(owner, "address_name", input, port),
  ).toBeDefined();
  expect(fs.realpath).toHaveBeenCalledWith(path);
});
it("a matched static relative selector never probes process.cwd before scoped readers", async () => {
  const root = await createTestTempDirectory("rea-static-selector-");
  const path = join(root, "owned");
  await fs.writeFile(path, "owned");
  const port = createOwnedAppleStaticSession();
  const owner = {};
  registerOwnedFixtureHandlerPort(owner, port);
  registerOwnedFixtureHandlerEnvironment(owner, {});
  const input = { path: "." };
  const token = await sealOwnedFixturePolicy(
    {
      roots: [root],
      files: [
        {
          path,
          role: "dependency",
          sha256: createHash("sha256").update("owned").digest("hex"),
        },
      ],
      static_inventory: { directories: [] },
      environment: [],
      endpoints: [],
      available_capabilities: ["static"],
      grants: [
        {
          operation: "inspect_keyed_archive",
          input_digest: digestOwnedFixtureInput(input),
          capability: "static",
          mode: "owned-static",
          port_id: "static",
        },
      ],
    },
    { owned_static_ports: [{ port_id: "static", reference: port }] },
  );
  attachOwnedFixturePolicy(owner, token, port);
  vi.clearAllMocks();
  expect(
    await admitOwnedFixtureOperation(
      owner,
      "inspect_keyed_archive",
      input,
      port,
    ),
  ).toBeDefined();
  expect(fs.realpath).not.toHaveBeenCalledWith(process.cwd());
  expect(fs.lstat).not.toHaveBeenCalledWith(process.cwd());
  await port.close();
});
