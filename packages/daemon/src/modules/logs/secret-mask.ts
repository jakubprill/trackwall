/**
 * Secret masking (§4.2, §8): values the daemon knows are replaced with `***` in a line before it reaches the buffer,
 * the JSONL file and the state's last lines. Today the daemon knows only the environment it starts a process with, so a secret
 * is the value of a variable whose name looks like a secret; secrets injected by the `secrets` module will come in here.
 */

const MASK = "***";

/**
 * A variable name segment (between `_` or at the end) that means a secret: `GH_TOKEN`, `DB_PASSWORD`, `JWT_SECRET`,
 * `NPM_AUTH_TOKEN`, `STRIPE_API_KEY`. It does not catch `PWD` (the working directory) or `TOKENIZERS_PARALLELISM`.
 */
const SECRET_NAME = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIALS?|PAT)(_|$)/i;

/** Shorter values (`true`, `1`, `dev`) would replace ordinary words throughout the log. */
const MIN_SECRET_CHARS = 8;

/**
 * The values of variables with secret names. A multi-line value (a PEM key) gives each of its lines
 * separately, because output is masked line by line.
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
 * Replaces every occurrence of a secret with `***`. Occurrences are searched in the original line and merged before anything
 * is replaced, so secrets that overlap or contain one another vanish entirely.
 */
export function maskSecrets(line: string, secrets: readonly string[]): string {
  const ranges: [number, number][] = [];
  for (const secret of secrets) {
    // An empty string matches everywhere, and `indexOf` would loop at the end of the line.
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
