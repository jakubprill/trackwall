/**
 * Expanding `${key}` and `${key:default}` the way Spring does (§4.6, ADR-30): the value from the profile's configuration
 * view, and without it the default after the colon (also nested, `${a:${b:c}}`). A key that is missing and has no
 * default (usually an environment variable, `${ORDERS_URL}`) stays in the text; `expandPlaceholders` also takes the
 * keys the environment sets (ADR-153). The values come from the repo (§8): the depth and length of the result are
 * limited, and every key is resolved once per expansion.
 */

const MAX_DEPTH = 10;
const MAX_LENGTH = 4096;

/** The configuration entry a value comes from: evidence for the expanded text. */
export interface PlaceholderSource {
  value: string;
  path: string;
  line: number;
}

export interface Resolved {
  value: string;
  /** The first configuration entry a value was taken from; `undefined` when the text had no expanded key. */
  source: PlaceholderSource | undefined;
}

export function resolvePlaceholders(text: string, get: (key: string) => PlaceholderSource | undefined): Resolved {
  return new Resolver(get, NO_SOURCES).resolve(text, 0);
}

/** Keys an expansion treats apart from the configuration, and how many placeholders it may still read (ADR-153). */
export interface ExpansionKeys {
  /** Keys another property source sets before the files (the environment): they win over the files and their default. */
  outside: (key: string) => boolean;
  /** Keys whose value must not appear in the result (secrets): never expanded, nor is their placeholder's default. */
  hidden: (key: string) => boolean;
  /**
   * Placeholders left to read, shared by every expansion of one request: a repo can make each value read thousands, so
   * past it a placeholder stays as it is in the text, and the caller says the result is cut.
   */
  budget: { left: number };
}

const NO_SOURCES: ExpansionKeys = { outside: () => false, hidden: () => false, budget: { left: Number.POSITIVE_INFINITY } };

/** An expansion that also says which keys came from outside the configuration, took their default, or had no value at all. */
export interface Expanded extends Resolved {
  /** Keys `outside` set, in the order met; each stays as `${key}` in the value. */
  outside: string[];
  /** Keys without an entry or a value outside that took their placeholder's default. */
  defaulted: string[];
  /** Keys without an entry, a default or a value outside; each stays as its `${…}` in the value. */
  missing: string[];
}

/**
 * Expanding as Spring does with another property source before the configuration files (the environment, ADR-153):
 * a key `outside` sets wins over the files and its default and stays as `${key}`, since its value is not read here,
 * and a `hidden` key stays as `${key}` whatever sets it.
 */
export function expandPlaceholders(text: string, get: (key: string) => PlaceholderSource | undefined, keys: ExpansionKeys): Expanded {
  const resolver = new Resolver(get, keys);
  return {
    ...resolver.resolve(text, 0),
    outside: [...resolver.outside],
    defaulted: [...resolver.defaulted],
    missing: [...resolver.missing],
  };
}

class Resolver {
  private readonly get: (key: string) => PlaceholderSource | undefined;
  private readonly keys: ExpansionKeys;
  private readonly memo = new Map<string, Resolved | undefined>();
  readonly outside = new Set<string>();
  readonly defaulted = new Set<string>();
  readonly missing = new Set<string>();

  constructor(get: (key: string) => PlaceholderSource | undefined, keys: ExpansionKeys) {
    this.get = get;
    this.keys = keys;
  }

  resolve(text: string, depth: number): Resolved {
    if (text.length > MAX_LENGTH || !text.includes("${")) return { value: text, source: undefined };
    let value = "";
    let source: PlaceholderSource | undefined;
    for (let i = 0; i < text.length; ) {
      const start = text.indexOf("${", i);
      const end = start < 0 ? -1 : closingBrace(text, start + 2);
      if (end < 0) {
        value += text.slice(i);
        break;
      }
      const part = this.placeholder(text.slice(start + 2, end), depth) ?? { value: text.slice(start, end + 1), source: undefined };
      value += text.slice(i, start) + part.value;
      source ??= part.source;
      if (value.length > MAX_LENGTH) return { value: text, source: undefined };
      i = end + 1;
    }
    return { value, source };
  }

  /** One `${…}` without its braces; `undefined` when the key is missing and there is no default. */
  private placeholder(inner: string, depth: number): Resolved | undefined {
    const colon = topLevelColon(inner);
    const key = colon < 0 ? inner : inner.slice(0, colon);
    if (this.keys.budget.left-- <= 0) return undefined;
    if (this.keys.outside(key)) {
      this.outside.add(key);
      return { value: `\${${key}}`, source: undefined };
    }
    if (this.keys.hidden(key)) {
      if (this.get(key) === undefined) (colon < 0 ? this.missing : this.defaulted).add(key);
      return { value: `\${${key}}`, source: undefined };
    }
    const fromKey = depth < MAX_DEPTH ? this.key(key, depth) : undefined;
    if (fromKey) return fromKey;
    if (colon >= 0) {
      this.defaulted.add(key);
      return this.resolve(inner.slice(colon + 1), depth + 1);
    }
    this.missing.add(key);
    return undefined;
  }

  private key(key: string, depth: number): Resolved | undefined {
    if (this.memo.has(key)) return this.memo.get(key);
    const entry = this.get(key);
    // While it is being resolved the key counts as “missing”: the cycle `a: ${a}` ends on it, not on the depth limit.
    this.memo.set(key, undefined);
    const resolved = entry && { value: this.resolve(entry.value, depth + 1).value, source: entry };
    this.memo.set(key, resolved);
    return resolved;
  }
}

/**
 * The text with the default taken out of every `${key:default}` left in it, as `${key}`: an expansion that stopped at a
 * limit gives back its text unexpanded, and a secret key's default must not show (ADR-153).
 */
export function withoutDefaults(text: string): string {
  let out = "";
  let i = 0;
  for (let start = text.indexOf("${"); start >= 0; start = text.indexOf("${", i)) {
    const end = closingBrace(text, start + 2);
    if (end < 0) break;
    const inner = text.slice(start + 2, end);
    const colon = topLevelColon(inner);
    out += `${text.slice(i, start)}\${${colon < 0 ? inner : inner.slice(0, colon)}}`;
    i = end + 1;
  }
  return out + text.slice(i);
}

/** The index of the `}` closing a `${` opened before `from`; `-1` when there is none. */
function closingBrace(text: string, from: number): number {
  let depth = 1;
  for (let i = from; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

/** The colon that separates the default, outside a nested `${…}`; `-1` when there is none. */
function topLevelColon(inner: string): number {
  let depth = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ":" && depth === 0) return i;
  }
  return -1;
}
