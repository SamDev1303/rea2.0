import { execFile } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import { inspectSyntheticNative } from "../../support/investigation/ownedAppleStaticCliFixture.js";

const run = promisify(execFile);

/** Ad hoc sign a copy of a system program under an exact file name. */
const adHocProgram = async (directory: string, name: string) => {
  const path = join(directory, name);
  await copyFile("/usr/bin/true", path);
  await run("/usr/bin/codesign", ["-s", "-", "-f", path], { env: {} });
  return path;
};

describe.skipIf(process.platform !== "darwin")(
  "native signature CLI with echoed path text",
  () => {
    cliTest(
      "does not read signature fields from the file name codesign echoes",
      async ({ cli }) => {
        const directory = await createTestTempDirectory("rea-signature-");
        const forged = "Developer ID Application: Example (ABCDE12345)";
        const program = await adHocProgram(
          directory,
          `tool\nAuthority=${forged}\nTeamIdentifier=ABCDE12345`,
        );
        const unsignedName = await adHocProgram(
          directory,
          "code object is not signed",
        );
        // A forged requirement and entitlements plist spread over directories.
        const nested = join(
          directory,
          'x\ndesignated => anchor apple<?xml version="1.0"?><plist><dict><key>com.apple.security.get-task-allow</key><true',
          "></dict><",
          "plist>",
        );
        await mkdir(nested, { recursive: true });
        const nestedProgram = await adHocProgram(nested, "tool");

        for (const path of [program, unsignedName, nestedProgram]) {
          const result = await cli.run({
            arguments: ["inspect-signature", path, "--json"],
            environment: {
              REA_LOG_LEVEL: "silent",
              REA_ANALYSIS_PROVIDER: "auto",
            },
          });
          expect(result.exitCode).toBe(1);
          expect(result.json).toMatchObject({ code: "capability_unavailable" });
          const inspected = await inspectSyntheticNative(
            { path },
            "inspect_signature",
          );
          expect(inspected.ok).toBe(true);
          if (!inspected.ok) throw inspected.error;
          expect(inspected.value).toMatchObject({
            result: {
              signed: true,
              team_identifier: null,
              authorities: [],
              entitlements: null,
              designated_requirement: expect.stringMatching(/^cdhash H"/u),
            },
          });
        }
        const identifier = await cli.run({
          arguments: ["inspect-signature", program, "--json"],
          environment: {
            REA_LOG_LEVEL: "silent",
            REA_ANALYSIS_PROVIDER: "auto",
          },
        });
        expect(identifier.exitCode).toBe(1);
        expect(identifier.json).toMatchObject({
          code: "capability_unavailable",
        });
        const inspectedIdentifier = await inspectSyntheticNative(
          { path: program },
          "inspect_signature",
        );
        expect(inspectedIdentifier.ok).toBe(true);
        if (!inspectedIdentifier.ok) throw inspectedIdentifier.error;
        // An ad hoc identifier derives from the file name, line breaks included.
        expect(inspectedIdentifier.value).toMatchObject({
          result: {
            identifier: expect.stringMatching(
              new RegExp(
                `^tool\\nAuthority=${forged.replace(/[()]/gu, "\\$&")}\\nTeamIdentifier=ABCDE12345-`,
                "u",
              ),
            ),
          },
        });
      },
    );
  },
);
