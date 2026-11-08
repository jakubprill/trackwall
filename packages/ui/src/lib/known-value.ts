/** A value read from storage, if it is one of `values`; anything else, for example from a newer version, is `undefined`. */
export function knownValue<T extends string>(values: readonly T[], value: string | null): T | undefined {
  return values.find((v) => v === value);
}
