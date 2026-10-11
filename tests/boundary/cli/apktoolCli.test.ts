import { expect, it } from "vitest";
import { join } from "node:path";
import { lstat } from "node:fs/promises";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { registerApktoolCommands } from "../../../src/cli/apktoolCommands.js";
import { ApktoolProvider } from "../../../src/apktool/ApktoolProvider.js";
import { silentLogger } from "../../../src/logger.js";
import { serveRegisteredCliFixture } from "../../support/cli/registeredCliFixture.js";

import { serveCli as serve } from "./cliServeHarness.js";

it.each(["inspect-apktool-client", "decode-android-resources"])(
  "%s advertises a schema through the public CLI",
  async (command) => {
    const result = await serve([command, "--schema", "--json"]);
    expect(result.exitCode, command).toBe(0);
    const schema = JSON.parse(result.stdout) as { args?: unknown };
    expect(schema).toBeTruthy();
  },
);

it("reports a missing apktool launcher with recovery guidance", async () => {
  const result = await serve(["inspect-apktool-client", "--json"], {
    REA_APKTOOL_COMMAND: "/nonexistent/apktool",
  });
  expect(result.stdout).toContain("capability_unavailable");
  const missing = join(
    await createTestTempDirectory("rea-apktool-missing-"),
    "absent-apktool",
  );
  await expect(lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
  const provider = new ApktoolProvider({
    environment: { REA_APKTOOL_COMMAND: missing },
  });
  try {
    const parsed = await serveRegisteredCliFixture(
      (cli) => {
        registerApktoolCommands(cli, silentLogger, {}, provider);
      },
      ["inspect-apktool-client", "--json"],
    );
    expect(parsed.exitCode).toBe(1);
    expect(parsed.stdout).toContain("capability_unavailable");
    expect(parsed.stdout).toContain("REA_APKTOOL_COMMAND");
    expect(parsed.stdout).toContain(missing);
  } finally {
    await provider.close();
  }
  await expect(lstat(missing)).rejects.toMatchObject({ code: "ENOENT" });
});

it("validates the locale option before launching apktool", async () => {
  const result = await serve([
    "decode-android-resources",
    "/targets/app.apk",
    "--locale",
    "not a locale",
    "--json",
  ]);
  expect(result.stdout).toContain("invalid");
});
