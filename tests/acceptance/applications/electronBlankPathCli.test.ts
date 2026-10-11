import { expect } from "vitest";
import pino from "pino";
import { registerElectronCommands } from "../../../src/cli/electronCommands.js";
import { serveRegisteredCliFixture } from "../../support/cli/registeredCliFixture.js";

import { cliTest } from "../../support/cli/cliFixture.js";

cliTest.for(["", " \t "])(
  "rejects blank Electron application_root (%j) before filesystem or provider work",
  async (applicationRoot, { cli }) => {
    const arguments_ = [
      "capture-electron-scenario",
      JSON.stringify({
        executable_path: "/synthetic/missing-electron",
        application_path: "/synthetic/missing-app",
        application_root: applicationRoot,
      }),
      "--json",
    ];
    const denied = await cli.run({ arguments: arguments_, timeoutMs: 15000 });
    expect(denied.exitCode).toBe(1);
    expect(denied.json).toMatchObject({ code: "capability_unavailable" });
    const response = await serveRegisteredCliFixture(
      (registered) =>
        registerElectronCommands(registered, pino({ level: "silent" }), {}),
      arguments_,
    );
    expect(response.exitCode).toBe(1);
    expect(response.json).toMatchObject({
      code: "invalid_request",
      details: {
        operation: "capture_electron_scenario",
        issues: expect.arrayContaining([
          expect.objectContaining({ path: ["application_root"] }),
        ]),
      },
    });
  },
);
