import { describe, expect, it, vi } from "vitest";
import {
  localRegistrationCommand,
  isOwnedClientRegistrationCommand,
} from "./ClientRegistrationIdentity.js";
import { runUpdate } from "./Update.js";
import type { UpdateHost } from "./Update.js";

describe("REA 2.0 checkout ownership", () => {
  it("registers our exact Node and launcher instead of a package runner", () => {
    const command = localRegistrationCommand();
    expect(command[0]).toBe(process.execPath);
    expect(command[1]).toMatch(/[\\/]scripts[\\/]rea\.mjs$/);
    expect(command[2]).toBe("mcp");
    expect(isOwnedClientRegistrationCommand(command)).toBe(true);
  });
  it.each([
    ["npx", "-y", "rea-agents@latest", "mcp"],
    ["npx", "-y", "rea2-local@6.4.0", "mcp"],
    ["rea2", "mcp"],
    ["/unrelated/rea2", "mcp"],
    [process.execPath, "/unrelated/scripts/rea.mjs", "mcp"],
    ["node", "/unrelated/scripts/rea.mjs", "mcp"],
    ["cmd.exe", "/c", "npx", "-y", "rea-agents", "mcp"],
  ])(
    "does not adopt another executable or upstream registration: %s",
    (...command) => {
      expect(isOwnedClientRegistrationCommand(command)).toBe(false);
    },
  );
  it("refuses automatic update before invoking any host effects", async () => {
    const effect = vi.fn(() => {
      throw new Error("must not run");
    });
    const host: UpdateHost = {
      localBuild: true,
      installation: effect,
      latestVersion: effect,
      installVersion: effect,
      installedVersion: effect,
      planMaintenance: effect,
    };
    expect(await runUpdate("6.4.0", host)).toMatchObject({
      status: "failed",
      reason: "unknown-install-method",
      latestVersion: null,
    });
    expect(effect).not.toHaveBeenCalled();
  });
});
