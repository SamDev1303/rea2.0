/** Deliberately defective owned fixture; do not use this rule in production. */
export const referenceAcceptsQuantity = (quantity: number): boolean =>
  quantity !== 0;
