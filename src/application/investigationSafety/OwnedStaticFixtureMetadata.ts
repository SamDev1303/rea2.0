import { dirname, relative, sep } from "node:path";
import { ownedFixtureUnavailable } from "./OwnedFixturePolicyData.js";

/** An absent first component under a complete inventoried ancestor proves descendant absence. */
export const absentMetadata = (
  inventory: {
    readonly directories: ReadonlyMap<string, unknown>;
    readonly children: ReadonlyMap<string, readonly string[]>;
  },
  path: string,
): boolean => {
  let ancestor = dirname(path);
  while (true) {
    if (inventory.directories.has(ancestor)) {
      const first = relative(ancestor, path).split(sep)[0];
      const children = inventory.children.get(ancestor);
      if (children === undefined)
        throw ownedFixtureUnavailable("owned_static_fixture");
      return first !== undefined && !children.includes(first);
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) return false;
    ancestor = parent;
  }
};
class OwnedStaticFixtureAbsentMetadata extends Error {
  readonly code = "ENOENT";
  constructor() {
    super(
      "The sealed inventory proves this optional metadata candidate absent.",
    );
  }
}
/** Expected absence is reported without a raw stat/realpath probe of an unlisted candidate. */
export const throwOwnedStaticFixtureAbsentMetadata = (): never => {
  throw new OwnedStaticFixtureAbsentMetadata();
};
