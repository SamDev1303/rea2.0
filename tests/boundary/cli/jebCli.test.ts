import { once } from "node:events";
import { createServer } from "node:http";
import pino from "pino";
import { expect, it } from "vitest";
import { registerJebCommands } from "../../../src/cli/jebCommands.js";
import { serveRegisteredCliFixture } from "../../support/cli/registeredCliFixture.js";

import { serveCli } from "./cliServeHarness.js";

const jebEnvironment = {
  REA_JEB_MCP_URL: "http://127.0.0.1:1/mcp",
};

const serve = async (
  argv: readonly string[],
): Promise<{ readonly stdout: string; readonly exitCode: number }> =>
  serveCli(argv, jebEnvironment);

it.each([
  ["inspect-jeb-client"],
  ["open-jeb-project"],
  ["list-jeb-units"],
  ["decompile-jeb-item"],
])("%s advertises a schema through the public CLI", async (command) => {
  const result = await serve([command, "--schema", "--json"]);
  expect(result.exitCode, command).toBe(0);
  const schema = JSON.parse(result.stdout) as { args?: unknown };
  expect(schema).toBeTruthy();
});

it("reports an unreachable engine endpoint with recovery guidance", async () => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    response.writeHead(503);
    response.end("Authored unavailable JEB fixture");
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Owned JEB diagnostic fixture has no TCP address");
  try {
    const denied = await serve(["inspect-jeb-client", "--json"]);
    expect(denied.stdout).toContain("capability_unavailable");
    expect(requests).toBe(0);
    const result = await serveRegisteredCliFixture(
      (cli) =>
        registerJebCommands(cli, pino({ level: "silent" }), {
          REA_JEB_MCP_URL: `http://127.0.0.1:${String(address.port)}/mcp`,
        }),
      ["inspect-jeb-client", "--json"],
    );
    expect(result.stdout).toContain("capability_unavailable");
    expect(result.stdout).toContain("REA_JEB_MCP_URL");
    expect(requests).toBeGreaterThan(0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((cause) =>
        cause === undefined ? resolve() : reject(cause),
      ),
    );
  }
});

it("validates decompile item input before contacting the engine", async () => {
  const result = await serve([
    "decompile-jeb-item",
    "not-an-address",
    "--item-kind",
    "method",
    "--json",
  ]);
  expect(result.stdout).toBeTruthy();
  expect(result.stdout).not.toContain("capability_unavailable");
});
