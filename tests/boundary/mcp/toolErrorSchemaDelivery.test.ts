import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";

it("delivers typed tool failures without violating the advertised success schema over stdio", async () => {
  const root = await mkdtemp(join(tmpdir(), "rea-tool-error-schema-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const missing = join(root, "not-present.bin");
  // Source-owned direct parser setup preserves missing-file diagnostics separately from admission-first transport denial.
  const parsed = await parseBinaryTarget(missing);
  expect(parsed).toMatchObject({
    ok: false,
    error: {
      _tag: "BinaryTargetError",
      path: missing,
      reason: expect.stringContaining("target does not exist"),
      cause: { code: "ENOENT" },
    },
  });
  if (parsed.ok) throw new Error("Missing owned fixture unexpectedly resolved");
  expect(JSON.stringify(projectAnalysisError(parsed.error))).toContain(missing);
  const { client, call } = await connectLocalToolsMcp();
  const tools = (await client.listTools()).tools;
  const failures: string[] = [];
  const requests = [
    { name: "list_documents", arguments: {} },
    { name: "open_binary", arguments: { path: missing } },
    {
      name: "analyze_javascript_application",
      arguments: { input_path: missing },
    },
    { name: "inspect_artifact", arguments: {} },
  ];
  for (const request of requests) {
    const tool = tools.find(({ name }) => name === request.name);
    if (tool?.outputSchema === undefined)
      throw new Error(`${request.name} omitted its output schema`);
    const reply = await client.callTool(request);
    const diagnostic = parseMcpToolError(reply);
    expect(diagnostic.error.message, request.name).not.toBe("");
    if (request.name === "open_binary" || request.name === "inspect_artifact") {
      expect(diagnostic.error, request.name).toMatchObject({
        code: "capability_unavailable",
        details: {
          provider_id: "rea2-protected-host",
          operation: request.name,
        },
      });
      expect(JSON.stringify(diagnostic), request.name).not.toContain(missing);
    } else if ("input_path" in request.arguments) {
      expect(JSON.stringify(diagnostic), request.name).toContain(missing);
    }
    if (reply.structuredContent !== undefined) {
      const validate = new Ajv2020({
        strict: false,
        validateFormats: false,
      }).compile(z.record(z.string(), z.unknown()).parse(tool.outputSchema));
      if (!validate(reply.structuredContent)) failures.push(request.name);
    }
  }
  expect(failures).toEqual([]);
  const successful = await call("get_evidence_bundle", {});
  expect(successful.isError).not.toBe(true);
  expect(successful.structuredContent).toBeDefined();
  await client.ping();
});
