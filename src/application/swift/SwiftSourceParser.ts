import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";
import { createHash } from "node:crypto";
import type { SwiftSourceFile } from "../../domain/swift/swiftSourceAnalysis.js";
import { lexSwiftSource, type SwiftToken } from "./SwiftSourceLexer.js";

const types = new Set([
  "class",
  "struct",
  "enum",
  "protocol",
  "actor",
  "extension",
]);
const callable = new Set(["func", "init", "deinit", "subscript"]);
const kinds = new Set([...types, ...callable, "typealias", "let", "var"]);
const nonCalls = new Set([
  "if",
  "while",
  "switch",
  "for",
  "catch",
  "guard",
  "return",
  "throw",
  "sizeof",
  "func",
  "init",
  "subscript",
]);
const position = ({ offset_utf16, line, column_utf16 }: SwiftToken) => ({
  offset_utf16,
  line,
  column_utf16,
});

/** Recover declaration boundaries and candidate calls, without claiming semantic resolution. */
export const parseSwiftSource = (
  path: string,
  bytes: Buffer,
  signal?: AbortSignal,
): SwiftSourceFile => {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause: unknown) {
    throw new ArtifactReaderFailure(
      "format",
      "Swift source is not valid UTF-8",
      { cause },
    );
  }
  const tokens = lexSwiftSource(source, signal);
  const { pairs, diagnostics } = pairBraces(tokens);
  const { imports, declarations, declarationNames } = mapDeclarations(
    path,
    tokens,
    { pairs, diagnostics },
  );
  bindDeclarationParents(declarations);
  const callCandidates = mapCallCandidates(
    tokens,
    declarations,
    declarationNames,
  );
  return {
    path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    imports,
    declarations,
    call_candidates: callCandidates,
    diagnostics: [...new Set(diagnostics)],
  };
};

const pairBraces = (tokens: SwiftToken[]) => {
  const pairs = new Map<number, number>();
  const stack: number[] = [];
  const diagnostics: string[] = [];
  for (const [index, token] of tokens.entries()) {
    if (diagnostics.length >= 128)
      throw new ArtifactReaderFailure(
        "limit",
        "Swift syntax diagnostic budget exceeded",
      );
    if (token.text === "{") stack.push(index);
    if (token.text === "}") {
      const start = stack.pop();
      if (start === undefined)
        diagnostics.push(`Unmatched closing brace at line ${token.line}`);
      else pairs.set(start, index);
    }
  }
  if (stack.length)
    diagnostics.push(
      "Unmatched opening braces; declaration bodies are incomplete",
    );
  if (tokens.some((t, i) => t.text === "/" && tokens[i - 1]?.text !== "."))
    diagnostics.push(
      "Slash tokens may include Swift regex literals or operators; regex contents are not semantically classified",
    );
  return { pairs, diagnostics };
};

const mapDeclarations = (
  path: string,
  tokens: SwiftToken[],
  scope: { pairs: Map<number, number>; diagnostics: string[] },
) => {
  const { pairs, diagnostics } = scope;
  const imports: SwiftSourceFile["imports"] = [];
  const declarations: SwiftSourceFile["declarations"] = [];
  const declarationNames = new Set<number>();
  // A token limit alone does not bound repeated scans of incomplete headers.
  const headerWork = { remaining: 1_000_000 };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.text === "import") {
      let index = i + 1;
      if (kinds.has(tokens[index]?.text ?? "")) index++;
      const module = tokens[index];
      if (module?.identifier)
        imports.push({
          module: module.text.replaceAll("`", ""),
          location: position(module),
        });
      continue;
    }
    if (
      !kinds.has(token.text) ||
      tokens[i - 1]?.text === "import" ||
      tokens[i - 1]?.text === "."
    )
      continue;
    // `class func` and `class var` are modifiers, not type declarations.
    if (
      token.text === "class" &&
      ["func", "var", "subscript"].includes(tokens[i + 1]?.text ?? "")
    )
      continue;
    const implicit = ["init", "deinit", "subscript"].includes(token.text);
    const nameToken = implicit ? token : tokens[i + 1];
    if (
      nameToken === undefined ||
      (!implicit && !nameToken.identifier && token.text !== "func")
    )
      continue;
    const name = nameToken.text.replaceAll("`", "");
    declarationNames.add(implicit ? i : i + 1);
    const { end, hasBody } = declarationExtent(i, nameToken, {
      tokens,
      pairs,
      diagnostics,
      headerWork,
    });
    declarations.push({
      id: `${path}:${token.offset_utf16}`,
      kind: token.text as SwiftSourceFile["declarations"][number]["kind"],
      name,
      parent_id: null,
      location: position(token),
      end_offset_utf16: end,
      has_body: hasBody,
    });
  }
  return { imports, declarations, declarationNames };
};

const bindDeclarationParents = (
  declarations: SwiftSourceFile["declarations"],
) => {
  const parents: SwiftSourceFile["declarations"] = [];
  for (const declaration of declarations) {
    while (
      parents.length &&
      parents.at(-1)!.end_offset_utf16 <= declaration.location.offset_utf16
    )
      parents.pop();
    declaration.parent_id = parents.at(-1)?.id ?? null;
    if (declaration.has_body) parents.push(declaration);
  }
};

const mapCallCandidates = (
  tokens: SwiftToken[],
  declarations: SwiftSourceFile["declarations"],
  declarationNames: Set<number>,
) => {
  const callCandidates: SwiftSourceFile["call_candidates"] = [];
  let declAt = 0;
  const parents: SwiftSourceFile["declarations"] = [];
  for (const [index, token] of tokens.entries()) {
    while (
      declAt < declarations.length &&
      declarations[declAt]!.location.offset_utf16 <= token.offset_utf16
    ) {
      const declaration = declarations[declAt++]!;
      while (
        parents.length &&
        parents.at(-1)!.end_offset_utf16 <= declaration.location.offset_utf16
      )
        parents.pop();
      if (declaration.has_body) parents.push(declaration);
    }
    while (
      parents.length &&
      parents.at(-1)!.end_offset_utf16 <= token.offset_utf16
    )
      parents.pop();
    if (
      !token.identifier ||
      tokens[index + 1]?.text !== "(" ||
      declarationNames.has(index) ||
      nonCalls.has(token.text)
    )
      continue;
    callCandidates.push({
      name: token.text.replaceAll("`", ""),
      enclosing_declaration_id: parents.at(-1)?.id ?? null,
      location: position(token),
      resolution: "unresolved",
    });
  }
  return callCandidates;
};

/** Bound header scans across the whole file, including malformed nesting. */
const declarationExtent = (
  index: number,
  nameToken: SwiftToken,
  scope: {
    tokens: SwiftToken[];
    pairs: Map<number, number>;
    diagnostics: string[];
    headerWork: { remaining: number };
  },
) => {
  const { tokens, pairs, diagnostics } = scope;
  let end = nameToken.offset_utf16 + nameToken.text.length;
  let hasBody = false,
    parens = 0,
    brackets = 0;
  if (types.has(tokens[index]!.text) || callable.has(tokens[index]!.text)) {
    for (let j = index + 1; j < tokens.length; j++) {
      if (--scope.headerWork.remaining < 0)
        throw new ArtifactReaderFailure(
          "limit",
          "Swift declaration header work budget exceeded",
        );
      const next = tokens[j]!;
      if (next.text === "(") parens++;
      if (next.text === ")") parens--;
      if (next.text === "[") brackets++;
      if (next.text === "]") brackets--;
      if (parens === 0 && brackets === 0) {
        if (next.text === "{") {
          const close = pairs.get(j);
          hasBody = close !== undefined;
          if (close !== undefined) end = tokens[close]!.offset_utf16 + 1;
          else
            diagnostics.push(
              `Unclosed declaration body at line ${tokens[index]!.line}`,
            );
          if (diagnostics.length >= 128)
            throw new ArtifactReaderFailure(
              "limit",
              "Swift syntax diagnostic budget exceeded",
            );
          break;
        }
        if (
          next.text === "}" ||
          next.text === ";" ||
          (j > index + 1 && kinds.has(next.text))
        )
          break;
      }
      end = next.offset_utf16 + next.text.length;
    }
  }
  return { end, hasBody };
};
