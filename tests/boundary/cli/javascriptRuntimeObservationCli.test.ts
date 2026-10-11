import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "vitest";
import pino from "pino";
import { registerJavaScriptRuntimeObservationCommands } from "../../../src/cliJavaScriptRuntimeCommands.js";
import { serveRegisteredCliFixture } from "../../support/cli/registeredCliFixture.js";
import { runCliJson } from "../../fixtures/cliJsonProcess.js";

import { observeJavaScriptRuntime } from "../../../src/application/javascript/JavaScriptRuntimeObservationService.js";
import { V8InspectorProvider } from "../../../src/inspector/V8InspectorProvider.js";
import { observeJavaScriptRuntimeInputSchema } from "../../../src/domain/javascript/javascriptRuntimeObservation.js";
import { startFakeV8Inspector } from "../../fixtures/inspector/fakeV8Inspector.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const TIMEOUT_MS = 20_000;

describe("JavaScript runtime observation CLI parity", () => {
  const resources: Array<{ close(): Promise<unknown> }> = [];
  const temporary: string[] = [];

  afterEach(async () => {
    await Promise.all(resources.splice(0).map((item) => item.close()));
    await Promise.all(
      temporary
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  test(
    "returns the same passive Inspector Evidence contracts",
    async () => {
      const root = await createTestTempDirectory("rea-v8-cli-");
      temporary.push(root);
      const entry = join(root, "entry.js");
      await writeFile(entry, "export const value = 1;\n");
      const inspector = await startFakeV8Inspector({
        targetUrl: pathToFileURL(entry).href,
      });
      resources.push(inspector);
      const environment = { ...process.env };

      const listed = await runCli(
        ["list-javascript-runtime-targets", inspector.endpoint, "--json"],
        environment,
      );
      expect(listed).toMatchObject({
        operation: "list_javascript_runtime_targets",
        provider: { id: "rea-v8-inspector" },
        normalized_result: {
          targets: [{ target_id: inspector.targetId }],
        },
      });

      const observed = await runCli(
        [
          "observe-javascript-runtime",
          inspector.endpoint,
          inspector.targetId,
          "--runtime-kind",
          "node",
          "--observation-ms",
          "10",
          "--json",
        ],
        environment,
      );
      expect(observed).toMatchObject({
        operation: "observe_javascript_runtime",
        provider: { id: "rea-v8-inspector" },
        normalized_result: {
          target: { target_id: inspector.targetId, runtime_kind: "node" },
          scripts: {
            items: [
              expect.objectContaining({
                location: { kind: "file", file_path: entry },
              }),
            ],
          },
        },
      });
      const direct = await observeJavaScriptRuntime(
        new V8InspectorProvider(),
        observeJavaScriptRuntimeInputSchema.parse({
          inspector_endpoint: inspector.endpoint,
          target_id: inspector.targetId,
          runtime_kind: "node",
          observation_ms: 10,
        }),
      );
      expect(direct.ok).toBe(true);
      if (direct.ok)
        expect(evidenceIdFrom(observed)).toBe(direct.value.evidence_id);
    },
    TIMEOUT_MS,
  );
});

const runCli = async (
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<unknown> => {
  if (
    !["list-javascript-runtime-targets", "observe-javascript-runtime"].includes(
      arguments_[0] ?? "",
    )
  )
    throw new Error("Outside the authored Inspector fixture commands");
  const denied = await runCliJson(arguments_, { PATH: environment.PATH ?? "" });
  expect(denied).toMatchObject({ code: "capability_unavailable" });
  return (
    await serveRegisteredCliFixture(
      (registered) =>
        registerJavaScriptRuntimeObservationCommands(
          registered,
          pino({ level: "silent" }),
        ),
      arguments_,
    )
  ).json;
};

const evidenceIdFrom = (value: unknown): string => {
  if (typeof value !== "object" || value === null)
    throw new TypeError("Missing CLI Evidence");
  const id = Reflect.get(value, "evidence_id");
  if (typeof id !== "string") throw new TypeError("Missing CLI Evidence ID");
  return id;
};
