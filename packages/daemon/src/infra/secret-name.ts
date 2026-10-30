/**
 * Whether an environment variable's name says it holds a secret (§8): a name segment (between `_` or at the end) such as
 * `GH_TOKEN`, `DB_PASSWORD`, `JWT_SECRET`, `NPM_AUTH_TOKEN`, `STRIPE_API_KEY`, and mise's `MISE_AGE_KEY`, which
 * decrypts all the others, and every `COPILOT_PROVIDER_*` setting of Copilot CLI's own model provider (ADR-136), whose
 * base URL may carry a key and which no tool of the agent needs. It does not catch `PWD` (the working directory) or `TOKENIZERS_PARALLELISM`. One rule for the masking of logs (`logs`) and for the variables a session's
 * Copilot CLI redacts (`agents`, ADR-93).
 */
const SECRET_NAME = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|APIKEY|API_KEY|PRIVATE_KEY|AGE_KEY|CREDENTIALS?|PAT)(_|$)/i;

/** Copilot CLI's settings of another model provider (BYOK). */
const PROVIDER_SETTING = /^COPILOT_PROVIDER_/i;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name) || PROVIDER_SETTING.test(name);
}
