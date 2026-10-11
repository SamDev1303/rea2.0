import { parse } from "@babel/parser";
import { ownedFixtureUnavailable } from "./OwnedFixturePolicyData.js";
import { verifyOwnedNodeFixtureSyntax } from "./OwnedNodeFixtureProfile.js";
import { verifyOwnedTimedFixtureExpressions } from "./OwnedTimedFixtureExpressions.js";

type Syntax = Record<string, unknown>;
function denied(): never {
  throw ownedFixtureUnavailable("owned_fixture");
}
const syntax = (value: unknown): Syntax =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Syntax)
    : denied();
const name = (value: unknown): string | undefined => {
  const node = syntax(value);
  return node.type === "Identifier" && typeof node.name === "string"
    ? node.name
    : undefined;
};
const timerKinds = new Map([
  ["setTimeout", "clearTimeout"],
  ["setInterval", "clearInterval"],
]);
const reservedNames = new Set([
  "process",
  "Object",
  "String",
  "Number",
  "Boolean",
  "JSON",
  "undefined",
  "NaN",
  "Infinity",
  ...timerKinds.keys(),
  ...timerKinds.values(),
]);
interface TimedSyntaxState {
  readonly calls: WeakSet<object>;
  readonly handles: Map<string, string>;
  readonly handleUses: WeakSet<object>;
  readonly identifiers: Syntax[];
  readonly callbacks: Syntax[];
  intervals: number;
  timers: number;
  nodes: number;
}
const approveTimer = (
  value: unknown,
  state: TimedSyntaxState,
  identifier?: unknown,
): boolean => {
  const call = syntax(value);
  if (call.type !== "CallExpression") return false;
  const callee = name(call.callee);
  if (callee === undefined || !timerKinds.has(callee)) return false;
  if (++state.timers > 64) denied();
  if (callee === "setInterval" && ++state.intervals > 4) denied();
  state.calls.add(call);
  if (identifier !== undefined) {
    const handle = name(identifier);
    if (
      handle === undefined ||
      reservedNames.has(handle) ||
      state.handles.has(handle)
    )
      denied();
    state.handles.set(handle, timerKinds.get(callee)!);
    state.handleUses.add(syntax(identifier));
  }
  return true;
};
const approveTopLevelTimers = (
  body: readonly unknown[],
  state: TimedSyntaxState,
): void => {
  for (const value of body) {
    const statement = syntax(value);
    if (statement.type === "ExpressionStatement") {
      approveTimer(statement.expression, state);
      continue;
    }
    if (statement.type !== "VariableDeclaration") denied();
    if (statement.kind !== "const" || !Array.isArray(statement.declarations))
      denied();
    for (const value of statement.declarations) {
      const declaration = syntax(value);
      const identifier = name(declaration.id);
      if (identifier === undefined || reservedNames.has(identifier)) denied();
      if (declaration.init !== null)
        approveTimer(declaration.init, state, declaration.id);
    }
  }
};
const timerCallback = (call: Syntax, state: TimedSyntaxState): Syntax => {
  if (
    !state.calls.has(call) ||
    !Array.isArray(call.arguments) ||
    call.arguments.length !== 2
  )
    denied();
  const [callbackValue, delayValue] = call.arguments;
  const callback = syntax(callbackValue);
  const delay = syntax(delayValue);
  if (
    callback.type !== "ArrowFunctionExpression" ||
    callback.async !== false ||
    !Array.isArray(callback.params) ||
    callback.params.length !== 0 ||
    delay.type !== "NumericLiteral" ||
    typeof delay.value !== "number" ||
    !Number.isInteger(delay.value) ||
    delay.value < 1 ||
    delay.value > 10000
  )
    denied();
  const body = syntax(callback.body);
  if (body.type !== "BlockStatement")
    return { type: "ExpressionStatement", expression: body };
  if (
    !Array.isArray(body.directives) ||
    body.directives.length !== 0 ||
    !Array.isArray(body.body) ||
    body.body.length > 16 ||
    body.body.some((value) => syntax(value).type !== "ExpressionStatement")
  )
    denied();
  return { type: "Program", body: body.body };
};
const approveClearTimer = (
  node: Syntax,
  state: TimedSyntaxState,
  callee: string,
): void => {
  if (!Array.isArray(node.arguments) || node.arguments.length !== 1) denied();
  const handle = name(node.arguments[0]);
  if (handle === undefined || state.handles.get(handle) !== callee) denied();
  state.handleUses.add(syntax(node.arguments[0]));
};
const sanitizeTimedSyntax = (
  value: unknown,
  state: TimedSyntaxState,
  depth = 0,
): unknown => {
  if (depth > 64) denied();
  if (Array.isArray(value))
    return value.map((item) => sanitizeTimedSyntax(item, state, depth + 1));
  if (typeof value !== "object" || value === null) return value;
  const node = syntax(value);
  if (typeof node.type !== "string") return value;
  if (++state.nodes > 10000) denied();
  if (node.type === "Identifier") state.identifiers.push(node);
  if (
    node.type === "MemberExpression" &&
    name(node.object) === "process" &&
    name(node.property) === "env"
  )
    denied();
  if (node.type === "CallExpression") {
    const callee = name(node.callee);
    if (callee !== undefined && timerKinds.has(callee)) {
      state.callbacks.push(
        syntax(
          sanitizeTimedSyntax(timerCallback(node, state), state, depth + 1),
        ),
      );
      return { type: "NumericLiteral", value: 0 };
    }
    if (callee === "clearTimeout" || callee === "clearInterval") {
      approveClearTimer(node, state, callee);
      return { type: "NumericLiteral", value: 0 };
    }
  }
  return Object.fromEntries(
    Object.entries(node).map(([key, item]) => [
      key,
      sanitizeTimedSyntax(item, state, depth + 1),
    ]),
  );
};

/** Opt-in controller profile; no source syntax can choose it or create authority. */
export const verifyOwnedTimedNodeFixtureScript = (source: string): void => {
  if (Buffer.byteLength(source, "utf8") > 1024 * 1024) denied();
  const parsed = parse(source, { sourceType: "module" });
  const state: TimedSyntaxState = {
    calls: new WeakSet(),
    handles: new Map(),
    handleUses: new WeakSet(),
    identifiers: [],
    callbacks: [],
    intervals: 0,
    timers: 0,
    nodes: 0,
  };
  approveTopLevelTimers(parsed.program.body, state);
  const sanitized = sanitizeTimedSyntax(parsed, state);
  for (const identifier of state.identifiers)
    if (
      typeof identifier.name === "string" &&
      state.handles.has(identifier.name) &&
      !state.handleUses.has(identifier)
    )
      denied();
  const expressions = [sanitized, ...state.callbacks];
  verifyOwnedTimedFixtureExpressions(expressions);
  verifyOwnedNodeFixtureSyntax(expressions);
};
