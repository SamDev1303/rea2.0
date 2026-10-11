import { expect, it } from "vitest";
import { parseSwiftSource } from "./SwiftSourceParser.js";

it("maps real declarations and calls while excluding comments, raw strings and interpolation", () => {
  const source = `import Foundation
/* outer /* func hidden() {} */ actor Fake {} */
actor Recorder {
  let message = #"func pretend() { }"#
  let interpolated = "\\(describe(\"func fake() {}\"))"
  func save(value: String) async throws {
    writeSettings(value)
    deleteFromKeychain()
  }
}
`;
  const result = parseSwiftSource("Recorder.swift", Buffer.from(source));
  expect(result.imports.map((item) => item.module)).toEqual(["Foundation"]);
  expect(result.declarations.map((item) => item.name)).toEqual([
    "Recorder",
    "message",
    "interpolated",
    "save",
  ]);
  const actor = result.declarations[0]!,
    save = result.declarations[3]!;
  expect(save.parent_id).toBe(actor.id);
  expect(save.location.line).toBe(6);
  expect(save.has_body).toBe(true);
  expect(result.call_candidates.map((item) => item.name)).toEqual([
    "writeSettings",
    "deleteFromKeychain",
  ]);
  expect(
    result.call_candidates.every(
      (item) =>
        item.enclosing_declaration_id === save.id &&
        item.resolution === "unresolved",
    ),
  ).toBe(true);
  expect(result.diagnostics).toEqual([]);
});

it("retains protocol requirements without assigning the next method's body", () => {
  const result = parseSwiftSource(
    "Contract.swift",
    Buffer.from(`protocol Engine {
    func start() async
    func stop()
}
extension Engine {
    func reset() { stop() }
}
`),
  );
  expect(result.declarations.map((item) => [item.name, item.has_body])).toEqual(
    [
      ["Engine", true],
      ["start", false],
      ["stop", false],
      ["Engine", true],
      ["reset", true],
    ],
  );
  expect(result.declarations[1]!.parent_id).toBe(result.declarations[0]!.id);
  expect(result.declarations[4]!.parent_id).toBe(result.declarations[3]!.id);
});

it("does not classify class method modifiers or selective imports as type declarations", () => {
  const result = parseSwiftSource(
    "Model.swift",
    Buffer.from(
      "import struct Foundation.Data\nclass Model { class func make() {} }",
    ),
  );
  expect(result.imports[0]!.module).toBe("Foundation");
  expect(result.declarations.map((item) => item.name)).toEqual([
    "Model",
    "make",
  ]);
});

it("refuses malformed string/comment carriers and cancellation instead of returning complete coverage", () => {
  expect(() =>
    parseSwiftSource("Bad.swift", Buffer.from('let s = "unterminated')),
  ).toThrow("Unterminated");
  expect(() =>
    parseSwiftSource("Bad.swift", Buffer.from("/* never closed")),
  ).toThrow("Unterminated");
  expect(() =>
    parseSwiftSource(
      "Stop.swift",
      Buffer.from("struct Valid {}"),
      AbortSignal.abort(),
    ),
  ).toThrow("cancelled");
});

it("reports unmatched braces as partial syntax evidence", () => {
  const result = parseSwiftSource(
    "Partial.swift",
    Buffer.from("struct Broken { func missing() {"),
  );
  expect(result.diagnostics).toContain(
    "Unmatched opening braces; declaration bodies are incomplete",
  );
  expect(result.declarations.every((item) => !item.has_body)).toBe(true);
});

it("rejects invalid UTF-8 and bounded lexer exhaustion", () => {
  expect(() => parseSwiftSource("Bad.swift", Buffer.from([0xff]))).toThrow(
    "not valid UTF-8",
  );
  expect(() =>
    parseSwiftSource("Deep.swift", Buffer.from("/*".repeat(257))),
  ).toThrow("nesting limit");
  expect(() =>
    parseSwiftSource("Dense.swift", Buffer.from(";".repeat(300_001))),
  ).toThrow("token limit");
});

it("bounds repeated incomplete declaration scans and syntax diagnostics", () => {
  expect(() =>
    parseSwiftSource("Incomplete.swift", Buffer.from("func f(".repeat(15_000))),
  ).toThrow("header work budget");
  expect(() =>
    parseSwiftSource("Closing.swift", Buffer.from("}".repeat(129))),
  ).toThrow("diagnostic budget");
});
