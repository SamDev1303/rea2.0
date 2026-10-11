import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, onTestFinished } from "vitest";
import pino from "pino";
import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { ok } from "../../../src/domain/result.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { registerUtilityCommands } from "../../../src/cli/utilityCommands.js";
import { inspectSyntheticPlist } from "../../support/investigation/ownedAppleStaticCliFixture.js";
import { serveRegisteredCliFixture } from "../../support/cli/registeredCliFixture.js";
import { connectOwnedEvidenceFixture } from "../../support/cli/ownedEvidenceFixture.js";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const encodingFixture = () => {
  const xml =
    '<?xml version="1.0" encoding="UTF-16"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>App</string><key>CFBundleIdentifier</key><string>dev.rea.encoding</string></dict></plist>';
  const utf16 = Buffer.from(xml, "utf16le");
  const utf8 = xml.replace("UTF-16", "UTF-8");
  const cases = [
    {
      name: "UTF-8 BOM",
      bytes: Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(utf8),
      ]),
      valid: true,
    },
    {
      name: "UTF-16 LE",
      bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), utf16]),
      valid: true,
    },
    {
      name: "UTF-16 BE",
      bytes: Buffer.concat([
        Buffer.from([0xfe, 0xff]),
        Buffer.from(utf16).swap16(),
      ]),
      valid: true,
    },
    {
      name: "unsupported declaration",
      bytes: Buffer.from(utf8.replace("UTF-8", "Shift_JIS")),
      valid: false,
    },
    {
      name: "declaration mismatch",
      bytes: Buffer.from(xml),
      valid: false,
    },
    {
      name: "truncated UTF-16",
      bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), utf16.subarray(0, -1)]),
      valid: false,
    },
    {
      name: "malformed UTF-8 executable",
      bytes: Buffer.concat([
        Buffer.from(utf8.split("<string>App</string>")[0] + "<string>"),
        Buffer.from([0xff]),
        Buffer.from("</string>" + utf8.split("<string>App</string>")[1]),
      ]),
      valid: false,
    },
  ];
  return { utf16, cases };
};

const produceOwnedBundlePlist = async (app: string) => {
  const target = await parseBinaryTarget(app);
  if (!target.ok) return target;
  const execution = await inspectSyntheticPlist({
    path: target.value.path,
    app,
  });
  if (!execution.ok) return execution;
  const value = execution.value;
  return ok(
    createEvidence(value.subject ?? target.value, value.provider, {
      operation: "inspect_plist",
      parameters: {},
      result: value.result,
      rawResult: value.rawResult,
      limitations: value.limitations,
      locations: value.locations,
    }),
  );
};

const runOwnedBundlePlistCli = (app: string) =>
  serveRegisteredCliFixture(
    (cli) =>
      registerUtilityCommands(
        cli,
        pino({ level: "silent" }),
        {},
        {
          runProviderAnalysis: async (path, operation, parameters) => {
            if (
              path !== app ||
              operation !== "inspect_plist" ||
              Object.keys(parameters ?? {}).length !== 0
            )
              throw new Error("Outside the authored app plist request");
            const result = await produceOwnedBundlePlist(app);
            return result.ok
              ? result.value
              : {
                  error: "Analysis failed",
                  ...projectAnalysisError(result.error),
                };
          },
          runSessionStatus: async () => {
            throw new Error("No session status request declared");
          },
        },
      ),
    ["inspect-plist", app, "--json"],
  );

describe.skipIf(process.platform !== "darwin")(
  "app bundle XML byte boundaries",
  () => {
    cliTest(
      "resolves real compiled bundles without changing executable names during decoding",
      async ({ cli, processes }) => {
        const directory = await createTestTempDirectory("rea-bundle-encoding-");
        const app = join(directory, "Example.app");
        const contents = join(app, "Contents");
        await mkdir(join(contents, "MacOS"), { recursive: true });
        const compiled = await processes.run("/usr/bin/xcrun", [
          "clang",
          resolve("tests/conformance/interface-builder/fixture.c"),
          "-o",
          join(contents, "MacOS", "App"),
        ]);
        expect(compiled.exitCode, compiled.stderr).toBe(0);
        const { utf16, cases } = encodingFixture();
        for (const { name, bytes, valid } of cases) {
          await writeFile(join(contents, "Info.plist"), bytes);
          const denied = await cli.run({
            arguments: ["inspect-plist", app, "--json"],
            environment: {
              REA_LOG_LEVEL: "silent",
              REA_ANALYSIS_PROVIDER: "auto",
            },
          });
          expect(denied.exitCode).toBe(1);
          expect(denied.json).toMatchObject({ code: "capability_unavailable" });
          const result = await runOwnedBundlePlistCli(app);
          expect(result.exitCode, `${name}: ${result.stdout}`).toBe(
            valid ? 0 : 1,
          );
          if (valid)
            expect(result.json).toMatchObject({
              normalized_result: {
                value: {
                  CFBundleExecutable: "App",
                  CFBundleIdentifier: "dev.rea.encoding",
                },
                bundle: { executable: "App" },
              },
            });
          else
            expect(result.json).toMatchObject({
              error: "Analysis failed",
              details: {
                path: join(contents, "Info.plist"),
                reason: expect.stringContaining(
                  "app Info.plist is malformed, unsupported, or lacks CFBundleExecutable",
                ),
              },
            });
        }
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [resolve("scripts/rea.mjs"), "mcp"],
          env: {
            PATH: process.env.PATH ?? "",
            REA_LOG_LEVEL: "silent",
            REA_ANALYSIS_PROVIDER: "auto",
          },
          stderr: "pipe",
        });
        const client = new Client({
          name: "bundle-encoding-parity",
          version: "1",
        });
        onTestFinished(async () => {
          try {
            await client.close();
          } finally {
            await transport.close();
          }
        });
        await client.connect(transport);
        await writeFile(
          join(contents, "Info.plist"),
          Buffer.concat([
            Buffer.from([0xfe, 0xff]),
            Buffer.from(utf16).swap16(),
          ]),
        );
        const opened = await client.callTool({
          name: "open_binary",
          arguments: { path: app },
        });
        expect(opened.isError).toBe(true);
        expect(parseMcpToolError(opened)).toMatchObject({
          error: { code: "capability_unavailable" },
        });
        const produced = await produceOwnedBundlePlist(app);
        expect(produced.ok).toBe(true);
        if (!produced.ok) throw produced.error;
        const owned = await connectOwnedEvidenceFixture();
        owned.session.recordEvidence(produced.value);
        const inspected = await owned.client.callTool({
          name: "get_evidence_bundle",
          arguments: {},
        });
        expect(inspected.isError, JSON.stringify(inspected)).not.toBe(true);
        expect(inspected.structuredContent).toMatchObject({
          result: { records: expect.arrayContaining([produced.value]) },
        });
        expect(produced.value).toMatchObject({
          normalized_result: {
            value: {
              CFBundleExecutable: "App",
              CFBundleIdentifier: "dev.rea.encoding",
            },
          },
        });
        await writeFile(
          join(contents, "Info.plist"),
          Buffer.concat([Buffer.from([0xff, 0xfe]), utf16.subarray(0, -1)]),
        );
        const invalid = await client.callTool({
          name: "open_binary",
          arguments: { path: app },
        });
        expect(invalid.isError).toBe(true);
        expect(parseMcpToolError(invalid)).toMatchObject({
          error: { code: "capability_unavailable" },
        });
        const malformed = await produceOwnedBundlePlist(app);
        expect(malformed.ok).toBe(false);
        if (malformed.ok)
          throw new Error("Malformed app metadata was accepted");
        expect(projectAnalysisError(malformed.error)).toMatchObject({
          details: {
            path: join(contents, "Info.plist"),
            reason: expect.stringContaining(
              "app Info.plist is malformed, unsupported, or lacks CFBundleExecutable",
            ),
          },
        });
      },
      45_000,
    );
  },
);
