import { truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";

import { WEB_NETWORK_CAPTURE_LIMITS } from "../../../src/domain/webNetworkCapture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import pino from "pino";
import { loadCompiledHistoricalCaptureFixture } from "../../support/web/compiledHistoricalCaptureFixture.js";
import { serveRegisteredCliFixture } from "../../support/cli/registeredCliFixture.js";
import { runCliJson } from "../../fixtures/cliJsonProcess.js";
import { connectOwnedEvidenceFixture } from "../../support/cli/ownedEvidenceFixture.js";
const entry = JSON.stringify({
  startedDateTime: "2026-01-01T00:00:00.000Z",
  time: 1,
  request: {
    method: "GET",
    url: "https://example.invalid/data",
    httpVersion: "HTTP/1.1",
    cookies: [],
    headers: [],
    queryString: [],
    headersSize: -1,
    bodySize: 0,
  },
  response: {
    status: 200,
    statusText: "OK",
    httpVersion: "HTTP/1.1",
    cookies: [],
    headers: [],
    content: { size: 512, mimeType: "text/plain", text: "x".repeat(512) },
    redirectURL: "",
    headersSize: -1,
    bodySize: 512,
  },
  cache: {},
  timings: { send: 0, wait: 1, receive: 0 },
});
const capture = (count: number) =>
  `{"log":{"version":"1.2","creator":{"name":"synthetic","version":"1"},"entries":[${Array<string>(count).fill(entry).join(",")}]}}`;

it("reports real HAR heap exhaustion through CLI and MCP and preserves server usability", async () => {
  const root = await createTestTempDirectory("rea-har-capacity-");
  const path = join(root, "caller-marked.har");
  const dense = capture(34_098);
  expect(Buffer.byteLength(dense)).toBeLessThan(
    WEB_NETWORK_CAPTURE_LIMITS.inputBytes,
  );
  await writeFile(path, dense);
  const { session, client } = await connectOwnedEvidenceFixture();
  const input = {
    capture_path: path,
    format: "har",
    sensitive_values: ["caller-marked"],
  };
  const denied = await client.callTool({
    name: "inspect_web_network_capture",
    arguments: input,
  });
  expect(denied.isError).toBe(true);
  const {
    createWebNetworkCaptureService,
    registerWebNetworkCaptureCommands,
    projectAnalysisError,
  } = await loadCompiledHistoricalCaptureFixture();
  const service = createWebNetworkCaptureService({});
  const response = await service.inspect(input);
  expect(response.ok).toBe(false);
  if (response.ok) throw new Error("Dense HAR unexpectedly fit the fixed heap");
  const projected = projectAnalysisError(response.error);
  expect({ error: projected }).toMatchObject({
    error: {
      code: "resource_constraint",
      retryable: false,
      message: expect.stringContaining("fixed V8 heap"),
      remediation: {
        action: expect.stringContaining(
          "smaller capture exported by its producer",
        ),
      },
      details: {
        resource: "memory",
        reported_limits: {
          old_generation_heap_mib: 192,
          observed_exit_code: process.platform === "win32" ? 134 : null,
          observed_signal: process.platform === "win32" ? null : "SIGABRT",
        },
        captured_output: {
          stderr: expect.stringContaining("heap out of memory"),
          truncated: false,
        },
      },
    },
  });
  expect(JSON.stringify(projected)).not.toContain("caller-marked");
  expect(JSON.stringify(projected)).not.toContain("rea doctor");
  const arguments_ = ["inspect-web-network-capture", path, "har", "--json"];
  expect(await runCliJson(arguments_, {})).toMatchObject({
    code: "capability_unavailable",
  });
  const failed = await serveRegisteredCliFixture(
    (registered) =>
      registerWebNetworkCaptureCommands(
        registered,
        pino({ level: "silent" }),
        {},
      ),
    arguments_,
  );
  expect(failed.exitCode).toBe(1);
  expect(failed.json).toMatchObject({ code: "resource_constraint" });
  const small = join(root, "small.har");
  await writeFile(small, capture(2));
  await client.ping();
  const control = await service.inspect({
    capture_path: small,
    format: "har",
  });
  expect(control.ok).toBe(true);
  if (!control.ok) throw control.error;
  expect(control.value).toMatchObject({
    normalized_result: { total_records: 2 },
  });
  expect(session.recordEvidence(control.value)).toMatchObject({ ok: true });
  const retained = await client.callTool({
    name: "get_evidence_bundle",
    arguments: {},
  });
  expect(retained.isError).not.toBe(true);
  expect(retained.structuredContent).toMatchObject({
    result: { records: expect.arrayContaining([control.value]) },
  });
  await truncate(path, WEB_NETWORK_CAPTURE_LIMITS.inputBytes + 1);
  const oversized = await service.inspect({
    capture_path: path,
    format: "har",
  });
  expect(oversized.ok).toBe(false);
  if (oversized.ok) throw new Error("Oversized capture unexpectedly accepted");
  expect(projectAnalysisError(oversized.error)).toMatchObject({
    code: "invalid_request",
  });
}, 60_000);
