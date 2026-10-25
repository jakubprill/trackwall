/**
 * English plurals of user-facing texts (ADR-32), shared by the daemon and the UI: one place for this rule.
 * `one` for 1, `other` for 0 and 2+.
 */
export interface NounForms {
  one: string;
  other: string;
}

export function pluralNoun(n: number, forms: NounForms): string {
  return n === 1 ? forms.one : forms.other;
}

/** A number with a noun: 1 change, 0 and 2+ changes. */
export function countLabel(n: number, forms: NounForms): string {
  return `${n} ${pluralNoun(n, forms)}`;
}
