import {
  APP_CONFIG_MAX_ENTRIES,
  type AppConfigEntry,
  type AppConfigModule,
  type AppConfigVariable,
  SPRING_DEFAULT_PROFILE,
  withoutCredentials,
} from "@trackwall/protocol";
import { envKey } from "../../infra/env-key.ts";
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
}

/**
 * `withoutCredentials` keeps only the path of a longer address, which may still hold its user and password, so such a
 * value is hidden whole.
 */
const MAX_ADDRESS_CHARS = 2048;
/** Spring Boot's `random.*` values (`${random.uuid}`) come from neither the files nor the environment. */
const RANDOM_KEY = /^random\./;

/** The modules in `configs` in the profile's view, only keys starting with `key` (compared as Spring does) when given. */
export function appConfigView(
  configs: ReadonlyMap<string, ModuleConfig>,
  request: { profile: string; key: string | undefined },
  env: AppConfigEnv,
): AppConfigView {
  const prefix = request.key === undefined ? "" : normalizeKey(request.key);
  let left = APP_CONFIG_MAX_ENTRIES;
  let truncated = false;
  const modules = [...configs.values()].map((config): AppConfigModule => {
    const matching = config.entries(request.profile).filter((e) => normalizeKey(e.key).startsWith(prefix));
    const kept = matching.slice(0, Math.max(left, 0));
    left -= kept.length;
    truncated ||= kept.length < matching.length;
    const shown = (key: string, profile: string) => {
      const entry = config.entry(key, profile);
      return entry === undefined ? null : appConfigEntry(config, entry, profile, env).value;
    };
    return {
      module: config.module,
      app: shown("spring.application.name", request.profile),
      profiles: config.profiles,
      activeProfiles: shown("spring.profiles.active", SPRING_DEFAULT_PROFILE),
      entries: kept.map((e) => appConfigEntry(config, e, request.profile, env)),
    };
  });
  return { modules, truncated };
}

function appConfigEntry(config: ModuleConfig, entry: ConfigEntry, profile: string, env: AppConfigEnv): AppConfigEntry {
  const expanded = expandPlaceholders(
    entry.value,
    (key) => config.entry(key, profile),
    (key) => RANDOM_KEY.test(key) || setVariable(env.vars, key) !== undefined,
  );
  const variables: AppConfigVariable[] = [
    ...expanded.outside.flatMap((key) => {
      const name = setVariable(env.vars, key);
      return name === undefined ? [] : [{ name, set: true }];
    }),
    ...expanded.missing.map((key) => ({ name: variableName(key), set: false })),
  ];
  const secret = isSecretKey(entry.key);
  return {
    key: entry.key,
    value: secret ? null : env.mask(withoutAddressCredentials(expanded.value)),
    secret,
    set: expanded.value.trim() !== "" && expanded.missing.length === 0,
    env: variables,
    overriddenBy: setVariable(env.vars, entry.key) ?? null,
    path: entry.path,
    line: entry.line,
  };
}

/**
 * A Spring key that names a secret, by the rule for environment variables (`isSecretName`) on its words:
 * `spring.datasource.password`, `client-secret`, `apiKey` and `token-uri` all count, which hides some values that are
 * not secret rather than show one that is.
 */
export function isSecretKey(key: string): boolean {
  return isSecretName(key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_"));
}

/**
 * The variable a run's environment sets for `key`, in its own spelling: the names Spring tries for a placeholder (the
 * key itself, with `.` and `-` as `_`, in upper case) and the one Spring Boot binds to a key (upper case, `_` for `.`,
 * without `-`, `_0` for `[0]`). `undefined` when none is set.
 */
function setVariable(vars: NodeJS.ProcessEnv, key: string): string | undefined {
  for (const name of variableNames(key)) {
    const found = envKey(vars, name);
    if (vars[found] !== undefined) return found;
  }
  return undefined;
}

function variableNames(key: string): string[] {
  const indexed = key.replace(/\[(\d+)\]/g, "_$1");
  const spellings = [key, key.replace(/\./g, "_"), key.replace(/-/g, "_"), indexed.replace(/[.-]/g, "_")];
  return [
    ...new Set([...spellings, ...spellings.map((s) => s.toUpperCase()), indexed.replace(/-/g, "").replace(/\./g, "_").toUpperCase()]),
  ];
}

/** The variable to set for a key no source sets: `DB_URL` as written, `orders.base-url` as `ORDERS_BASE_URL`. */
function variableName(key: string): string {
  return key
    .replace(/\[(\d+)\]/g, "_$1")
    .replace(/[.-]/g, "_")
    .toUpperCase();
}

/**
 * An address anywhere in a value without its user, password and query (`jdbc:postgresql://me:pw@db/orders?password=x`
 * → `jdbc:postgresql://***@db/orders`): `withoutCredentials` reads a one-word scheme, so the words before `://` are kept
 * as they are and the rest goes through it.
 */
export function withoutAddressCredentials(value: string): string {
  const at = value.indexOf("://");
  if (at < 0) return value;
  const head = value.slice(0, at);
  if (value.length > MAX_ADDRESS_CHARS) return `${head}://***`;
  return `${head}${withoutCredentials(`x${value.slice(at)}`).slice(1)}`;
}
