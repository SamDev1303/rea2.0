interface SnapshotLimits {
  readonly maximumBytes: number;
  readonly maximumNodes: number;
  readonly maximumDepth: number;
  readonly invalid: () => Error;
  readonly exhausted: () => Error;
}

/** Copy bounded plain data without invoking accessors or conversion hooks. */
export const snapshotPlainInput = <T>(input: T, limits: SnapshotLimits): T => {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  const consumeBytes = (value: string): void => {
    bytes += Buffer.byteLength(value);
    if (bytes > limits.maximumBytes) throw limits.exhausted();
  };
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > limits.maximumNodes || depth > limits.maximumDepth)
      throw limits.exhausted();
    if (typeof value === "string") {
      consumeBytes(value);
      return value;
    }
    if (value === undefined || value === null || typeof value === "boolean")
      return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object" || ancestors.has(value))
      throw limits.invalid();
    const prototype: unknown = Object.getPrototypeOf(value);
    if (
      !Array.isArray(value) &&
      prototype !== Object.prototype &&
      prototype !== null
    )
      throw limits.invalid();
    if (Reflect.ownKeys(value).some((key) => typeof key !== "string"))
      throw limits.invalid();
    if (Array.isArray(value) && value.length > limits.maximumNodes)
      throw limits.exhausted();
    ancestors.add(value);
    try {
      const entries: [string, unknown][] = [];
      for (const [key, descriptor] of Object.entries(
        Object.getOwnPropertyDescriptors(value),
      )) {
        if (!descriptor.enumerable) continue;
        if (!("value" in descriptor)) throw limits.invalid();
        consumeBytes(key);
        const copied = copy(descriptor.value, depth + 1);
        if (copied !== undefined) entries.push([key, copied]);
      }
      if (!Array.isArray(value))
        return Object.freeze(Object.fromEntries(entries));
      const values = new Map(entries);
      return Object.freeze(
        Array.from(
          { length: value.length },
          (_, index) => values.get(String(index)) ?? null,
        ),
      );
    } finally {
      ancestors.delete(value);
    }
  };
  return copy(input, 0) as T;
};
