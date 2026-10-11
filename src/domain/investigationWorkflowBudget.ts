/** Bounds reconciliation work independently of transport and source file readers. */
export const assertInvestigationWorkflowBudget = (value: unknown): void => {
  let remainingBytes = 1024 * 1024;
  let remainingNodes = 32768;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (--remainingNodes < 0 || depth > 32)
      throw new RangeError("Investigation exceeds its node or nesting budget.");
    if (typeof item === "string")
      remainingBytes -= Buffer.byteLength(item, "utf8");
    else if (item === null || typeof item !== "object") remainingBytes -= 8;
    else {
      if (ancestors.has(item))
        throw new TypeError("Investigation input must not contain cycles.");
      ancestors.add(item);
      try {
        for (const key in item) {
          if (!Object.hasOwn(item, key)) continue;
          remainingBytes -= Buffer.byteLength(key, "utf8") + 3;
          if (remainingBytes < 0)
            throw new RangeError(
              "Investigation exceeds its one MiB document budget.",
            );
          const property = Object.getOwnPropertyDescriptor(item, key);
          if (property === undefined || !("value" in property))
            throw new TypeError(
              "Investigation input must contain data properties only.",
            );
          visit(property.value, depth + 1);
        }
      } finally {
        ancestors.delete(item);
      }
    }
    if (remainingBytes < 0)
      throw new RangeError(
        "Investigation exceeds its one MiB document budget.",
      );
  };
  visit(value, 0);
};
