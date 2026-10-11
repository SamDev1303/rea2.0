import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";

export interface SwiftToken {
  readonly text: string;
  readonly offset_utf16: number;
  readonly line: number;
  readonly column_utf16: number;
  readonly identifier: boolean;
}

/** Bound inert lexing; comments, strings and interpolation never become declarations. */
export const lexSwiftSource = (
  source: string,
  signal?: AbortSignal,
): SwiftToken[] => {
  let at = 0,
    line = 1,
    column = 1;
  const tokens: SwiftToken[] = [];
  const check = () => {
    if (signal?.aborted)
      throw new ArtifactReaderFailure(
        "cancelled",
        "Swift source analysis cancelled",
      );
  };
  const malformed = (): never => {
    throw new ArtifactReaderFailure(
      "format",
      "Unterminated Swift source carrier",
    );
  };
  const advance = () => {
    if (source[at++] === "\n") {
      line++;
      column = 1;
    } else column++;
    if (at % 4096 === 0) check();
  };
  const advanceTo = (end: number) => {
    while (at < end) advance();
  };
  const comment = () => {
    if (source.startsWith("//", at)) {
      while (at < source.length && source[at] !== "\n") advance();
      return true;
    }
    if (!source.startsWith("/*", at)) return false;
    let depth = 1;
    advanceTo(at + 2);
    while (at < source.length && depth > 0) {
      if (source.startsWith("/*", at)) {
        if (++depth > 256)
          throw new ArtifactReaderFailure(
            "limit",
            "Swift comment nesting limit exceeded",
          );
        advanceTo(at + 2);
      } else if (source.startsWith("*/", at)) {
        depth--;
        advanceTo(at + 2);
      } else advance();
    }
    if (depth !== 0) malformed();
    return true;
  };
  const string = (depth = 0): boolean => {
    if (depth > 256)
      throw new ArtifactReaderFailure(
        "limit",
        "Swift string nesting limit exceeded",
      );
    let quoteAt = at;
    while (source[quoteAt] === "#") quoteAt++;
    if (source[quoteAt] !== '"') return false;
    const hashes = source.slice(at, quoteAt);
    const quote = source.startsWith('"""', quoteAt) ? '"""' : '"';
    const end = quote + hashes;
    advanceTo(quoteAt + quote.length);
    while (at < source.length) {
      if (source.startsWith(end, at)) {
        advanceTo(at + end.length);
        return true;
      }
      const escape = "\\" + hashes;
      if (source.startsWith(escape + "(", at)) {
        advanceTo(at + escape.length + 1);
        let brackets = 1;
        while (at < source.length && brackets > 0) {
          if (comment() || string(depth + 1)) continue;
          if (source[at] === "(") {
            if (++brackets > 256)
              throw new ArtifactReaderFailure(
                "limit",
                "Swift interpolation nesting limit exceeded",
              );
          } else if (source[at] === ")") brackets--;
          advance();
        }
        if (brackets !== 0) malformed();
      } else if (source.startsWith(escape, at)) {
        advanceTo(Math.min(source.length, at + escape.length + 1));
      } else advance();
    }
    return malformed();
  };
  check();
  while (at < source.length) {
    if (/\s/u.test(source[at]!)) {
      advance();
      continue;
    }
    if (comment() || string()) continue;
    const start = at,
      startLine = line,
      startColumn = column;
    let identifier = false;
    if (source[at] === "`") {
      advance();
      while (at < source.length && source[at] !== "`" && source[at] !== "\n")
        advance();
      if (source[at] !== "`") malformed();
      advance();
      identifier = true;
    } else if (/[\p{L}_]/u.test(source[at]!)) {
      identifier = true;
      advance();
      while (at < source.length && /[\p{L}\p{N}_]/u.test(source[at]!))
        advance();
    } else advance();
    tokens.push({
      text: source.slice(start, at),
      offset_utf16: start,
      line: startLine,
      column_utf16: startColumn,
      identifier,
    });
    if (tokens.length > 300_000)
      throw new ArtifactReaderFailure("limit", "Swift token limit exceeded");
  }
  return tokens;
};
