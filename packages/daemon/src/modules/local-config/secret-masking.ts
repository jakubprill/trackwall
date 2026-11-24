/**
 * The rules that take secrets out of a value before the workspace store keeps it (§4.13, ADR-299). Masking is by place
 * (a variable, a header, the value after `--token`, an address's password and query), since a token has no shape of its
 * own; a token with a prefix its issuer gives it (`ghp_`, `glpat-`, `sk-`) is masked wherever it is, as a last net for a
 * place no rule knows. A value that only names an environment variable stays, so a restore keeps the reference.
 */

/** What a masked value becomes: the user fills the real one in after a restore. */
export const MASKED = "<masked by Trackwall: fill in on this computer>";

/**
 * A value that names a secret rather than holding one: an environment variable (`${NAME}`, `$NAME`, upper case, as
 * Copilot CLI fills it in), optionally after a scheme (`Bearer ${TOKEN}`) or a header's or variable's name
 * (`Authorization: Bearer ${TOKEN}`, `GITHUB_TOKEN=${GITHUB_TOKEN}`).
 */
const REFERENCE = /^(?:[A-Za-z0-9_-]+\s*[:=]\s*)?(?:(?:Bearer|Basic|Token) )?(?:\$\{[A-Z_][A-Z0-9_]*\}|\$[A-Z_][A-Z0-9_]*)$/;

/** A name that says its value is a secret: `--token`, `API_KEY`, `AUTH_HEADER`, `--access-key`, `--credentials`. */
const SECRET_NAME = /token|secret|passw|api[-_]?key|access[-_]?key|private[-_]?key|auth|credential|cookie|session|(?:^|[-_])pat(?:$|[-_])/i;

/** Flags whose value is a header, a variable or a user with its password, any of which may carry a secret. */
const CARRIER_FLAG = /^--?(?:H|header|e|env|u|user)$/;

/** Flags that pass a variable on: after them a bare name (`-e GITHUB_TOKEN`) takes its value from the environment. */
const VARIABLE_FLAG = /^--?(?:e|env)$/;

/** A variable's bare name, as `docker run -e` takes it. */
const VARIABLE_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Tokens whose issuer gives them a prefix, masked wherever they are. */
const PREFIXED_TOKEN = /(?:gh[opsur]_|github_pat_|glpat-|sk-|xox[abprs]-|AKIA)[A-Za-z0-9_-]{8,}/g;

/** An address with a scheme, whose user, query and fragment may carry a token. */
const ADDRESS = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)(?:([^/?#]*)@)?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/s;

/** Schemes whose user is a login name, never a token: `ssh://git@host` keeps it. */
const SSH_SCHEME = /^(?:ssh|git\+ssh|sftp):\/\/$/i;

/** Whether `value` only names an environment variable. */
export function isReference(value: string): boolean {
  return REFERENCE.test(value);
}

/** Whether a key or flag name says its value is a secret. */
export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** A free string: its prefixed tokens masked, and when it is an address, the address masked. */
export function maskString(value: string): string {
  return maskAddress(value.replace(PREFIXED_TOKEN, MASKED));
}

/** An address of any scheme without its token (a user outside SSH, any password), with its query values and fragment masked. */
export function maskAddress(text: string): string {
  const match = ADDRESS.exec(text);
  if (!match) return text;
  const [, scheme = "", user, rest = "", query, fragment] = match;
  const keepUser = user !== undefined && SSH_SCHEME.test(scheme) && !user.includes(":");
  return `${scheme}${keepUser ? `${user}@` : ""}${rest}${maskedQuery(query)}${maskedFragment(fragment)}`;
}

/**
 * Command line arguments: `--token abc`, `--token=abc`, `-H "Authorization: Bearer abc"`, `-e GITHUB_TOKEN=abc`,
 * `-u me:pw` and `API_KEY=abc` keep the flag or name and lose the value; a reference and a variable passed on by name
 * stay, and every other argument is a free string.
 */
export function maskArgs(args: readonly string[]): string[] {
  return args.map((arg, i) => maskArg(arg, args[i - 1]));
}

function maskArg(arg: string, before: string | undefined): string {
  if (before !== undefined && takesSecret(before) && !/^--?[A-Za-z]/.test(arg)) {
    if (isReference(arg) || (VARIABLE_FLAG.test(before) && VARIABLE_NAME.test(arg))) return arg;
    return MASKED;
  }
  const eq = arg.indexOf("=");
  if (eq <= 0) return maskString(arg);
  const name = arg.slice(0, eq);
  const value = arg.slice(eq + 1);
  if (isReference(value)) return arg;
  const secret = name.startsWith("-") ? takesSecret(name) : isSecretName(name);
  return `${name}=${secret ? MASKED : maskString(value)}`;
}

/** A flag whose value is a secret or may carry one. */
function takesSecret(flag: string): boolean {
  return CARRIER_FLAG.test(flag) || (/^--?[A-Za-z]/.test(flag) && isSecretName(flag));
}

/** `?a=MASKED&b=${B}`: every value, and every bare part, that is not a reference masked; nothing without a query. */
function maskedQuery(query: string | undefined): string {
  if (query === undefined) return "";
  const params = query.split("&").map((param) => {
    const eq = param.indexOf("=");
    if (eq < 0) return param === "" ? param : MASKED;
    return isReference(param.slice(eq + 1)) ? param : `${param.slice(0, eq)}=${MASKED}`;
  });
  return `?${params.join("&")}`;
}

/** A fragment may carry a token (`#token=…`), so a non-empty one is masked whole. */
function maskedFragment(fragment: string | undefined): string {
  if (fragment === undefined) return "";
  return fragment === "" ? "#" : `#${MASKED}`;
}
