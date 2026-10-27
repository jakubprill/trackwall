/**
 * Whether an environment variable's name says it holds a secret (§8): a name segment (between `_` or at the end) such as
 * `GH_TOKEN`, `DB_PASSWORD`, `JWT_SECRET`, `NPM_AUTH_TOKEN`, `STRIPE_API_KEY`. It does not catch `PWD` (the working
 * directory) or `TOKENIZERS_PARALLELISM`. One rule for the masking of logs (`logs`) and for the variables a session's
 * Copilot CLI redacts (`agents`, ADR-93).
 */
const SECRET_NAME = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|APIKEY|API_KEY|PRIVATE_KEY|CREDENTIALS?|PAT)(_|$)/i;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** The values of the variables `names` in `vars` (the secrets of a mise environment), in that order. */
export function valuesNamed(vars: Record<string, string>, names: readonly string[]): string[] {
  return names.flatMap((name) => vars[name] ?? []);
}
