/**
 * Maskowanie sekretów (§4.2, §8): wartości znane daemonowi są zamieniane na `***` w linii, zanim trafi ona do bufora,
 * pliku JSONL i ostatnich linii stanu. Dziś daemon zna tylko środowisko, z którym uruchamia proces, więc sekretem
 * jest wartość zmiennej, której nazwa wygląda na sekret; sekrety wstrzykiwane przez moduł `secrets` dojdą tutaj.
 */

const MASK = "***";

/**
 * Segment nazwy zmiennej (między `_` albo na końcu), który znaczy sekret: `GH_TOKEN`, `DB_PASSWORD`, `JWT_SECRET`,
 * `NPM_AUTH_TOKEN`, `STRIPE_API_KEY`. Nie łapie `PWD` (katalog roboczy) ani `TOKENIZERS_PARALLELISM`.
 */
const SECRET_NAME = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIALS?|PAT)(_|$)/i;

/** Krótsze wartości (`true`, `1`, `dev`) zamieniałyby zwykłe słowa w całym logu. */
const MIN_SECRET_CHARS = 8;

/** Wartości zmiennych o nazwach sekretów, od najdłuższej, żeby sekret zawierający inny został zamaskowany w całości. */
export function secretValues(env: NodeJS.ProcessEnv): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && value.length >= MIN_SECRET_CHARS && SECRET_NAME.test(name)) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

export function maskSecrets(line: string, secrets: readonly string[]): string {
  let masked = line;
  for (const secret of secrets) masked = masked.replaceAll(secret, MASK);
  return masked;
}
