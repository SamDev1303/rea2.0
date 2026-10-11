import { ownedFixtureUnavailable } from "./OwnedFixturePolicyData.js";

type Syntax = Record<string, unknown>;
function denied(): never {
  throw ownedFixtureUnavailable("owned_fixture");
}
const syntax = (value: unknown): Syntax =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Syntax)
    : denied();
const nodeTypes = new Set([
  "File",
  "Program",
  "VariableDeclaration",
  "VariableDeclarator",
  "Identifier",
  "NumericLiteral",
  "StringLiteral",
  "BooleanLiteral",
  "NullLiteral",
  "ExpressionStatement",
  "MemberExpression",
  "CallExpression",
]);
const literals = new Set([
  "NumericLiteral",
  "StringLiteral",
  "BooleanLiteral",
  "NullLiteral",
]);
const memberName = (node: Syntax): string => {
  if (node.type === "Identifier" && typeof node.name === "string")
    return node.name;
  if (node.type !== "MemberExpression" || node.computed !== false) denied();
  const property = syntax(node.property);
  if (property.type !== "Identifier" || typeof property.name !== "string")
    denied();
  return `${memberName(syntax(node.object))}.${property.name}`;
};
const writes = new Set(["process.stdout.write", "process.stderr.write"]);
const literalBytes = (node: Syntax): number => {
  if (node.type === "NumericLiteral" && !Number.isFinite(node.value)) denied();
  if (node.type !== "StringLiteral") return 0;
  if (typeof node.value !== "string") denied();
  const bytes = Buffer.byteLength(node.value, "utf8");
  if (bytes > 4096) denied();
  return bytes;
};
const collectLiteralBinding = (
  node: Syntax,
  stringBindings: Set<string>,
): void => {
  if (node.type !== "VariableDeclarator") return;
  const id = syntax(node.id);
  const init = syntax(node.init);
  if (
    id.type !== "Identifier" ||
    typeof id.name !== "string" ||
    typeof init.type !== "string" ||
    !literals.has(init.type)
  )
    denied();
  if (init.type === "StringLiteral") stringBindings.add(id.name);
};

/** No aggregate construction or computed string expansion before capture limits. */
export const verifyOwnedTimedFixtureExpressions = (input: unknown): void => {
  const pending: unknown[] = [input];
  const stringBindings = new Set<string>();
  const calls: Syntax[] = [];
  let totalBytes = 0;
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const node = syntax(value);
    if (typeof node.type !== "string") continue;
    if (!nodeTypes.has(node.type)) denied();
    if ((totalBytes += literalBytes(node)) > 65536) denied();
    collectLiteralBinding(node, stringBindings);
    if (node.type === "CallExpression") calls.push(node);
    pending.push(...Object.values(node));
  }
  for (const call of calls) {
    if (
      !writes.has(memberName(syntax(call.callee))) ||
      !Array.isArray(call.arguments) ||
      call.arguments.length !== 1
    )
      denied();
    const argument = syntax(call.arguments[0]);
    if (
      argument.type !== "StringLiteral" &&
      !(
        argument.type === "Identifier" &&
        typeof argument.name === "string" &&
        stringBindings.has(argument.name)
      )
    )
      denied();
  }
};
