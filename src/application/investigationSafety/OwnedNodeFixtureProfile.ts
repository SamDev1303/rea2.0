import { parse } from "@babel/parser";
import { ownedFixtureUnavailable } from "./OwnedFixturePolicyData.js";

// Deliberately small controller-owned profile: no module loading or executable
// dependencies. Widening it requires a separately reviewed dependency adapter.
const fixtureNodeTypes = new Set([
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
  "BinaryExpression",
  "LogicalExpression",
  "UnaryExpression",
  "ConditionalExpression",
  "TemplateLiteral",
  "TemplateElement",
  "MemberExpression",
  "CallExpression",
  "ExportNamedDeclaration",
  "ObjectExpression",
  "ObjectProperty",
  "ArrayExpression",
]);
const fixtureCalls = new Set([
  "process.stdout.write",
  "process.stderr.write",
  "Object.hasOwn",
  "String",
  "Number",
  "Boolean",
  "JSON.stringify",
]);
const fixtureMembers = new Set([
  "process.stdout",
  "process.stderr",
  "process.stdout.write",
  "process.stderr.write",
  "process.env",
  "Object.hasOwn",
  "JSON.stringify",
]);
const fixtureGlobals = new Set([
  "process",
  "Object",
  "String",
  "Number",
  "Boolean",
  "JSON",
  "undefined",
  "NaN",
  "Infinity",
]);
const fixtureMemberName = (node: Record<string, unknown>): string => {
  if (node.type === "Identifier" && typeof node.name === "string")
    return node.name;
  if (
    node.type !== "MemberExpression" ||
    node.computed !== false ||
    typeof node.object !== "object" ||
    node.object === null ||
    typeof node.property !== "object" ||
    node.property === null
  )
    throw ownedFixtureUnavailable("owned_fixture");
  const property = node.property as Record<string, unknown>;
  if (property.type !== "Identifier" || typeof property.name !== "string")
    throw ownedFixtureUnavailable("owned_fixture");
  return `${fixtureMemberName(node.object as Record<string, unknown>)}.${property.name}`;
};
const collectFixtureIdentifierBindings = (
  node: Record<string, unknown>,
  localNames: Set<string>,
  identifiers: Record<string, unknown>[],
  propertyNames: WeakSet<object>,
): void => {
  if (node.type === "VariableDeclarator") {
    const id = node.id as Record<string, unknown>;
    if (
      id.type !== "Identifier" ||
      typeof id.name !== "string" ||
      fixtureGlobals.has(id.name)
    )
      throw ownedFixtureUnavailable("owned_fixture");
    localNames.add(id.name);
  }
  if (node.type === "Identifier") identifiers.push(node);
  if (
    (node.type === "MemberExpression" || node.type === "ObjectProperty") &&
    node.computed === false &&
    node.shorthand !== true
  ) {
    const property =
      node.type === "MemberExpression" ? node.property : node.key;
    if (typeof property === "object" && property !== null)
      propertyNames.add(property);
  }
};
const verifyFixtureIdentifiers = (
  identifiers: readonly Record<string, unknown>[],
  localNames: ReadonlySet<string>,
  propertyNames: WeakSet<object>,
): void => {
  for (const id of identifiers) {
    if (propertyNames.has(id)) continue;
    if (typeof id.name !== "string")
      throw ownedFixtureUnavailable("owned_fixture");
    if (!fixtureGlobals.has(id.name) && !localNames.has(id.name))
      throw ownedFixtureUnavailable("owned_fixture");
  }
};
export const verifyOwnedNodeFixtureScript = (source: string): void =>
  verifyOwnedNodeFixtureSyntax(parse(source, { sourceType: "module" }));

/** Shared expression grammar; callers must separately reject added control syntax. */
export const verifyOwnedNodeFixtureSyntax = (syntax: unknown): void => {
  const pending: unknown[] = [syntax];
  let nodes = 0;
  const localNames = new Set<string>();
  const identifiers: Record<string, unknown>[] = [];
  const propertyNames = new WeakSet<object>();
  while (pending.length > 0) {
    const value = pending.pop();
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const node = value as Record<string, unknown>;
    if (typeof node.type !== "string") continue;
    if (++nodes > 10000 || !fixtureNodeTypes.has(node.type))
      throw ownedFixtureUnavailable("owned_fixture");
    collectFixtureIdentifierBindings(
      node,
      localNames,
      identifiers,
      propertyNames,
    );
    if (node.type === "ExportNamedDeclaration" && node.source !== null)
      throw ownedFixtureUnavailable("owned_fixture");
    if (
      node.type === "MemberExpression" &&
      !fixtureMembers.has(fixtureMemberName(node))
    )
      throw ownedFixtureUnavailable("owned_fixture");
    if (
      node.type === "CallExpression" &&
      (typeof node.callee !== "object" ||
        node.callee === null ||
        !fixtureCalls.has(
          fixtureMemberName(node.callee as Record<string, unknown>),
        ))
    )
      throw ownedFixtureUnavailable("owned_fixture");
    if (
      node.type === "UnaryExpression" &&
      !["!", "+", "-", "typeof", "void"].includes(String(node.operator))
    )
      throw ownedFixtureUnavailable("owned_fixture");
    pending.push(...Object.values(node));
  }
  verifyFixtureIdentifiers(identifiers, localNames, propertyNames);
};
