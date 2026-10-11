import { describe, expect, vi } from "vitest";

import { registerBrowserScenarioCommands } from "../../../src/cliBrowserScenarioCommands.js";
import { registerElectronCommands } from "../../../src/cli/electronCommands.js";
import { silentLogger } from "../../../src/logger.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { serveRegisteredCliFixture } from "../../support/cli/registeredCliFixture.js";

const deniedFactories = vi.hoisted(() => ({
  browser: vi.fn(() => {
    throw new Error("Browser acquisition forbidden in parser fixture");
  }),
  electron: vi.fn(() => {
    throw new Error("Electron acquisition forbidden in parser fixture");
  }),
}));
vi.mock("../../../src/composition/browserScenario.js", () => ({
  createBrowserScenarioProvider: deniedFactories.browser,
}));
vi.mock("../../../src/composition/electronScenario.js", () => ({
  createElectronScenarioProvider: deniedFactories.electron,
}));

describe("scenario CLI schema diagnostics", () => {
  cliTest("reports browser scenario schema paths", async ({ cli }) => {
    const result = await cli.run({
      arguments: ["capture-browser-scenario", "{}", "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.json).toMatchObject({ code: "capability_unavailable" });
    const parsed = await serveRegisteredCliFixture(
      (fixture) => {
        registerBrowserScenarioCommands(fixture, silentLogger, {});
      },
      ["capture-browser-scenario", "{}", "--json"],
    );
    expect(deniedFactories.browser).not.toHaveBeenCalled();
    expect(parsed.exitCode).not.toBe(0);
    expect(parsed.json).toMatchObject({
      code: "invalid_request",
      details: {
        operation: "capture_browser_scenario",
        issues: expect.arrayContaining([
          {
            path: ["browser"],
            reason: "missing_argument",
            expected: "object",
          },
          {
            path: ["start_url"],
            reason: "missing_argument",
            expected: "object",
          },
          {
            path: ["actions"],
            reason: "missing_argument",
            expected: "array",
          },
        ]),
      },
    });
  });

  cliTest("reports Electron scenario schema paths", async ({ cli }) => {
    const result = await cli.run({
      arguments: ["capture-electron-scenario", "{}", "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.json).toMatchObject({ code: "capability_unavailable" });
    const parsed = await serveRegisteredCliFixture(
      (fixture) => {
        registerElectronCommands(fixture, silentLogger, {});
      },
      ["capture-electron-scenario", "{}", "--json"],
    );
    expect(deniedFactories.electron).not.toHaveBeenCalled();
    expect(parsed.exitCode).not.toBe(0);
    expect(parsed.json).toMatchObject({
      code: "invalid_request",
      details: {
        operation: "capture_electron_scenario",
        issues: expect.arrayContaining([
          {
            path: ["executable_path"],
            reason: "missing_argument",
            expected: "string",
          },
          {
            path: ["application_path"],
            reason: "missing_argument",
            expected: "string",
          },
        ]),
      },
    });
  });
});
