/**
 * Angielska liczba mnoga tekstów dla użytkownika (ADR-32), wspólna dla daemona i UI: jedno miejsce tej reguły.
 * `one` dla 1, `other` dla 0 i 2+.
 */
export interface NounForms {
  one: string;
  other: string;
}

export function pluralNoun(n: number, forms: NounForms): string {
  return n === 1 ? forms.one : forms.other;
}

/** Liczba z rzeczownikiem: 1 change, 0 i 2+ changes. */
export function countLabel(n: number, forms: NounForms): string {
  return `${n} ${pluralNoun(n, forms)}`;
}
