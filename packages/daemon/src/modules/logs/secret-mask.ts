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

/**
 * Wartości zmiennych o nazwach sekretów. Wartość wieloliniowa (klucz PEM) daje każdą swoją linię
 * osobno, bo wyjście jest maskowane po liniach.
 */
export function secretValues(env: NodeJS.ProcessEnv): string[] {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || !SECRET_NAME.test(name)) continue;
    for (const part of value.split(/\r?\n/)) if (part.length >= MIN_SECRET_CHARS) values.add(part);
  }
  return [...values];
}

/**
 * Zamienia każde wystąpienie sekretu na `***`. Wystąpienia są szukane w oryginalnej linii i łączone, zanim cokolwiek
 * zostanie zamienione, więc sekrety, które na siebie zachodzą albo jeden zawiera drugi, znikają w całości.
 */
export function maskSecrets(line: string, secrets: readonly string[]): string {
  const ranges: [number, number][] = [];
  for (const secret of secrets) {
    // Pusty napis pasuje wszędzie, a `indexOf` zapętliłby się na końcu linii.
    if (secret === "") continue;
    for (let at = line.indexOf(secret); at !== -1; at = line.indexOf(secret, at + 1)) ranges.push([at, at + secret.length]);
  }
  if (ranges.length === 0) return line;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let masked = "";
  let done = 0;
  for (const [start, end] of merged) {
    masked += `${line.slice(done, start)}${MASK}`;
    done = end;
  }
  return masked + line.slice(done);
}
