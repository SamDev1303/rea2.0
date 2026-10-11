import pino from "pino";
import { expect } from "vitest";

import { registerBrowserCommands } from "../../../src/cli/browserCommands.js";
import { registerAdvancedBrowserCommands } from "../../../src/cli/browserAdvancedCommands.js";
import { runCliJson } from "../../fixtures/cliJsonProcess.js";
import type { FakeCdpBrowser } from "../../fixtures/fakeCdpBrowser.js";
import { serveRegisteredCliFixture } from "../cli/registeredCliFixture.js";

const operations = new Set([
  "list-browser-targets",
  "inspect-web-page",
  "analyze-web-bundle",
  "observe-web-session",
  "discover-webmcp-tools",
  "capture-web-screenshot",
]);

/** Maintained service and command-format coverage on explicit authored fixtures.
 * The real public launcher still denies acquisition; this grants no host token.
 */
export const runRegisteredOwnedBrowserCli = async (
  browser: FakeCdpBrowser,
  arguments_: readonly string[],
): Promise<unknown> => {
  const operation = arguments_[0] ?? "";
  if (
    !operations.has(operation) ||
    arguments_[1] !== browser.endpoint ||
    (operation !== "list-browser-targets" && arguments_[2] !== "allowed-page")
  )
    throw new Error("Outside the declared authored browser fixture request");
  const commandCount = browser.commands.length;
  const denied = await runCliJson(arguments_, {});
  expect(denied).toMatchObject({ code: "capability_unavailable" });
  expect(browser.commands).toHaveLength(commandCount);
  return (
    await serveRegisteredCliFixture((cli) => {
      const logger = pino({ level: "silent" });
      registerBrowserCommands(cli, logger);
      registerAdvancedBrowserCommands(cli, logger);
    }, arguments_)
  ).json;
};
