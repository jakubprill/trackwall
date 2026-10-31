import {
  APP_CONFIG_MAX_ENTRIES,
  type AppConfigEntry,
  type AppConfigModule,
  type AppConfigVariable,
  SPRING_DEFAULT_PROFILE,
  withoutCredentialsInText,
} from "@trackwall/protocol";
import { isSecretName } from "../../infra/secret-name.ts";
import { expandPlaceholders } from "./placeholders.ts";
import { type ConfigEntry, type ModuleConfig, normalizeKey } from "./spring-config.ts";

/**
 * One profile's view of a repo's Spring configuration for an agent (§4.6, ADR-153): every module's entries with their
 * expanded values, read against the environment a run there gets. A secret's value and every variable's value stay in
 * the daemon: a secret entry says only whether it is set, a variable only whether a run has it.
 */

/** The environment of a run in the read place: its variables, only looked up by name, and masking of known secret values. */
export interface AppConfigEnv {
  vars: NodeJS.ProcessEnv;
  mask: (text: string) => string;
}

export interface AppConfigView {
  modules: AppConfigModule[];
  truncated: boolean;
  /** Placeholders were left unexpanded over `MAX_PLACEHOLDERS`. */
  expansionCut: boolean;
}

/** Spring Boot's `random.*` values (`${random.uuid}`) come from neither the files nor the environment. */
const RANDOM_KEY = /^random\./;
/** Placeholders read in one request across all entries; a hand-written configuration reads a few hundred. */
const MAX_PLACEHOLDERS = 20_000;
/** A longer value is not hand-written configuration; it is cut, so 500 entries stay a readable answer. */
const MAX_VALUE_CHARS = 2000;
/** The last word of a key that holds key material or a whole login: `jwt.key`, `signing-key`, `accessKey`, Kafka's `sasl.jaas.config`. */
const SECRET_KEY_END = /(^|_)(KEY|JAAS_CONFIG|CONNECTION_STRING)$/i;
/**
 * A secret written into a value under a key that does not say so: `password=…`, `pwd=…`, `password="…"` in a JAAS line,
 * `SharedAccessKey=…` and `AccountKey=…` in an Azure connection string; not `password=${…}`, which names another key.
 */
const SECRET_IN_VALUE =
  /(?:^|[^a-z])(?:password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|sharedaccesskey|accountkey)\s*[=:]\s*["']?[^\s"';,&$]/i;

/** Which profile's view, and only keys starting with `key` (compared as Spring does) when given. */
export interface AppConfigQuery {
  profile: string;
  key: string | undefined;
}

/** The modules in `configs` in the profile's view. */
export function appConfigView(configs: ReadonlyMap<string, ModuleConfig>, query: AppConfigQuery, env: AppConfigEnv): AppConfigView {
  const prefix = query.key === undefined ? "" : normalizeKey(query.key);
  const reader = new EntryReader(env);
  let left = APP_CONFIG_MAX_ENTRIES;
  let truncated = false;
  const modules = [...configs.values()].map((config): AppConfigModule => {
    const matching = config.entries(query.profile).filter((e) => normalizeKey(e.key).startsWith(prefix));
    const kept = matching.slice(0, Math.max(left, 0));
    left -= kept.length;
    truncated ||= kept.length < matching.length;
    const shown = (key: string, profile: string) => {
      const entry = config.entry(key, profile);
      return entry === undefined ? null : reader.entry(config, entry, profile).value;
    };
    return {
      module: config.module,
      app: shown("spring.application.name", query.profile),
      profiles: config.profiles,
      profileFound: query.profile === SPRING_DEFAULT_PROFILE || config.profiles.includes(query.profile),
      activeProfiles: shown("spring.profiles.active", SPRING_DEFAULT_PROFILE),
      entries: kept.map((e) => reader.entry(config, e, query.profile)),
    };
  });
  return { modules, truncated, expansionCut: reader.budget.left < 0 };
}

/** Entries of one request: the variables looked up once by name, and one budget of placeholders for all of them. */
class EntryReader {
  readonly budget = { left: MAX_PLACEHOLDERS };
  private readonly env: AppConfigEnv;
  /** The variables by the name they are looked up by: in upper case on Windows, where names ignore case (as `envKey`). */
  private readonly names: Map<string, string>;
  private readonly found = new Map<string, string | undefined>();

  constructor(env: AppConfigEnv) {
    this.env = env;
    this.names = new Map(Object.keys(env.vars).flatMap((name) => (env.vars[name] === undefined ? [] : [[lookupName(name), name]])));
  }

  /**
   * One entry. A secret key's value is never expanded into another value (`url: …;Password=${db.password}`), and a
   * placeholder's default is not used for one (`${API_TOKEN:dev-token}`): both stay `${key}`.
   */
  entry(config: ModuleConfig, entry: ConfigEntry, profile: string): AppConfigEntry {
    const expanded = expandPlaceholders(entry.value, (key) => config.entry(key, profile), {
      outside: (key) => RANDOM_KEY.test(key) || this.variable(key) !== undefined,
      hidden: isSecretKey,
      budget: this.budget,
    });
    const variables: AppConfigVariable[] = [
      ...expanded.outside.flatMap((key) => {
        const name = this.variable(key);
        return name === undefined ? [] : [{ name, set: true }];
      }),
      ...[...expanded.defaulted, ...expanded.missing].map((key) => ({ name: variableName(key), set: false })),
    ];
    // An address's own password and query go first; a secret left anywhere else in the value hides it whole.
    const shown = withoutCredentialsInText(expanded.value);
    const secret = isSecretKey(entry.key) || SECRET_IN_VALUE.test(shown);
    return {
      key: entry.key,
      value: secret ? null : this.env.mask(cut(shown)),
      secret,
      set: expanded.value.trim() !== "" && expanded.missing.length === 0,
      env: variables,
      overriddenBy: this.variable(entry.key) ?? null,
      path: entry.path,
      line: entry.line,
    };
  }

  /**
   * The variable a run's environment sets for `key`, in its own spelling: the names Spring tries for a placeholder (the
   * key itself, with `.` and `-` as `_`, in upper case) and the one Spring Boot binds to a key (upper case, `_` for `.`,
   * without `-`, `_0` for `[0]`). `undefined` when none is set.
   */
  private variable(key: string): string | undefined {
    if (!this.found.has(key)) {
      const name = variableNames(key).find((n) => this.names.has(lookupName(n)));
      this.found.set(key, name === undefined ? undefined : this.names.get(lookupName(name)));
    }
    return this.found.get(key);
  }
}

function lookupName(name: string): string {
  return process.platform === "win32" ? name.toUpperCase() : name;
}

function cut(value: string): string {
  return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…` : value;
}

/**
 * A Spring key that names a secret, by the rule for environment variables (`isSecretName`) on its words, or whose last
 * word is key material (`SECRET_KEY_END`): `spring.datasource.password`, `client-secret`, `apiKey`, `jwt.key`,
 * `sasl.jaas.config` and also `token-uri` count, which hides some values that are not secret rather than show one that is.
 */
export function isSecretKey(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_");
  return isSecretName(words) || SECRET_KEY_END.test(words);
}

function variableNames(key: string): string[] {
  const spellings = [key, key.replace(/\./g, "_"), key.replace(/-/g, "_"), key.replace(/[.-]/g, "_")];
  const bound = variableName(key.replace(/-/g, ""));
  return [...new Set([...spellings, ...spellings.map((s) => s.toUpperCase()), variableName(key), bound])];
}

/** The variable to set for a key no source sets: `DB_URL` as written, `orders.base-url` as `ORDERS_BASE_URL`, `[0]` as `_0`. */
function variableName(key: string): string {
  return key
    .replace(/\[(\d+)\]/g, "_$1")
    .replace(/[.-]/g, "_")
    .toUpperCase();
}
