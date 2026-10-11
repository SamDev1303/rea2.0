import { parse } from "@babel/parser";
import { describe, expect, it } from "vitest";
import {
  admitOwnedFixtureOperation,
  attachOwnedFixturePolicy,
  digestOwnedFixtureInput,
  registerOwnedFixtureHandlerEnvironment,
  sealOwnedFixturePolicy,
} from "../../../src/application/investigationSafety/OwnedFixturePolicy.js";
import { verifyOwnedTimedNodeFixtureScript } from "../../../src/application/investigationSafety/OwnedTimedNodeFixtureProfile.js";
import {
  OWNED_SPARSE_PROCESS_SOURCE,
  prepareOwnedSparseProcessFixture,
} from "../../support/investigation/ownedSparseProcessFixture.js";

describe("owned sparse process fixture preparation without execution", () => {
  it("authors exactly 65 literal writes and 2,004 PTY bytes with 64 bounded timers", () => {
    verifyOwnedTimedNodeFixtureScript(OWNED_SPARSE_PROCESS_SOURCE);
    const statements = parse(OWNED_SPARSE_PROCESS_SOURCE, {
      sourceType: "module",
    }).program.body;
    const lines: string[] = [];
    for (const [index, statement] of statements.entries()) {
      if (statement.type !== "ExpressionStatement")
        throw new Error("Fixture has a non-expression statement");
      const call = statement.expression;
      if (call.type !== "CallExpression")
        throw new Error("Fixture has a non-call expression");
      const write =
        index === 0
          ? call
          : call.arguments[0]?.type === "ArrowFunctionExpression"
            ? call.arguments[0].body
            : undefined;
      if (index !== 0) {
        expect(call.callee).toMatchObject({
          type: "Identifier",
          name: "setTimeout",
        });
        expect(call.arguments[1]).toMatchObject({
          type: "NumericLiteral",
          value: index * 20,
        });
      }
      if (write?.type !== "CallExpression")
        throw new Error("Fixture has no literal output call");
      const argument = write.arguments[0];
      if (argument?.type !== "StringLiteral")
        throw new Error("Fixture output is not a literal string");
      lines.push(argument.value);
    }
    expect(lines).toHaveLength(65);
    expect(lines[0]).toBe("board 00 completed; score 0\n");
    expect(lines.at(-1)).toBe("board 64 completed; score 640\n");
    expect(Buffer.byteLength(lines.join("").replaceAll("\n", "\r\n"))).toBe(
      2004,
    );
  });

  it.each(["cli", "mcp"] as const)(
    "predeclares exact %s input and validates its sealed profile without launching",
    async (adapter) => {
      const fixture = await prepareOwnedSparseProcessFixture(adapter);
      const operation =
        adapter === "cli" ? "capture-process" : "capture_process_scenario";
      const input =
        adapter === "cli"
          ? { args: { scenario: fixture.scenario }, options: {} }
          : fixture.input;
      expect(fixture.input.arguments).toEqual([
        "--max-old-space-size=64",
        expect.stringContaining("owned-timed.mjs"),
      ]);
      expect(fixture.input.limits.output_bytes).toBe(30000);
      expect(fixture.input.normalization).toEqual({
        ports: false,
        pids: false,
        paths: false,
        time_bucket_ms: 1,
        patterns: [],
      });
      expect(fixture.policy.grants).toEqual([
        {
          operation,
          input_digest: digestOwnedFixtureInput(input),
          capability: "owned-timed-process-capture",
          mode: "owned-files",
        },
      ]);
      const owner = {};
      const token = await sealOwnedFixturePolicy(fixture.policy);
      registerOwnedFixtureHandlerEnvironment(owner, {});
      attachOwnedFixturePolicy(owner, token);
      await expect(
        admitOwnedFixtureOperation(owner, operation, input),
      ).resolves.toMatchObject({ mode: "owned-files", environment: {} });
    },
  );
});
