import { z } from "zod";
import { CardProblem } from "./cards.ts";

/**
 * A Spring app's configuration as the files in a repo's working directory give it (ADR-153): the contract of the
 * `get_app_config` MCP tool. One profile's view of every module, each entry with its expanded value and its file and
 * line. A secret's value never leaves the daemon: the entry says only whether it is set. Variables the values read
 * from the environment are named with whether they are set, never with their values.
 */

/** The Spring profile of configuration without a profile; that is what Spring itself calls it. */
export const SPRING_DEFAULT_PROFILE = "default";
/** Most entries in one result, across all modules; a filter by key narrows a large configuration. */
export const APP_CONFIG_MAX_ENTRIES = 500;
/** The longest key filter: a Spring key prefix, not text to search. */
export const APP_CONFIG_KEY_MAX = 200;
/** The longest profile name the tool takes. */
export const APP_CONFIG_PROFILE_MAX = 100;

/** An environment variable a value reads, by name, and whether the environment of a run there sets it. */
export const AppConfigVariable = z.object({
  /** The variable that sets it, or, when none does, the name to set (`DB_URL`, `ORDERS_BASE_URL`). */
  name: z.string(),
  set: z.boolean(),
});
export type AppConfigVariable = z.infer<typeof AppConfigVariable>;

export const AppConfigEntry = z.object({
  /** The key as it stands in the file (`spring.datasource.url`, `orders.servers[0].host`). */
  key: z.string(),
  /**
   * The value with `${…}` expanded from the profile's view and defaults; a placeholder the environment sets stays as
   * `${NAME}`, an address loses its user, password and query, and a known secret is `***`. `null` for a secret.
   */
  value: z.string().nullable(),
  /** The key names a secret (`password`, `client-secret`, `api-key`, `token`…): its value is not given. */
  secret: z.boolean(),
  /** The value is not empty and no placeholder is left that neither the configuration, a default nor the environment sets. */
  set: z.boolean(),
  /**
   * The variables the value's placeholders read from the environment: those set, and those not set, whose placeholder
   * then took its default or stayed (`set: false` on the entry).
   */
  env: z.array(AppConfigVariable),
  /** The environment variable Spring Boot binds to this key instead of the file's value (`SPRING_DATASOURCE_URL`); `null` without one. */
  overriddenBy: z.string().nullable(),
  /** The file, relative to the repo root (or the task's worktree), with `/`, and the line of the key. */
  path: z.string(),
  line: z.number().int().positive(),
});
export type AppConfigEntry = z.infer<typeof AppConfigEntry>;

/** One module's configuration: the directory above `src/main/resources`. */
export const AppConfigModule = z.object({
  /** The module directory relative to the root, `""` for the root itself. */
  module: z.string(),
  /** `spring.application.name` in the profile's view; `null` without it. */
  app: z.string().nullable(),
  /** The profiles the module's files name, besides `default`. */
  profiles: z.array(z.string()),
  /** The files name the asked profile (or it is `default`); `false`: the view is the files without a profile alone. */
  profileFound: z.boolean(),
  /** `spring.profiles.active` in the files without a profile; the environment or the run's arguments may choose others. */
  activeProfiles: z.string().nullable(),
  entries: z.array(AppConfigEntry),
});
export type AppConfigModule = z.infer<typeof AppConfigModule>;

export const AppConfig = z.object({
  repo: z.string(),
  /** The task whose worktree was read; `null` for the repo root. */
  task: z.string().nullable(),
  /** The profile whose view is given; a module whose files do not name it gives its configuration without a profile (`profileFound`). */
  profile: z.string(),
  /** The configuration files read, relative to the read directory, with `/`, in the order Spring reads them. */
  files: z.array(z.string()),
  modules: z.array(AppConfigModule),
  /** Entries were left out over `APP_CONFIG_MAX_ENTRIES`. */
  truncated: z.boolean(),
  /**
   * Why the variables are judged without mise's `[env]` of that place (an untrusted config, a missing age key): then
   * a variable only mise sets shows as not set. `null` when mise's environment was read or there is no mise.
   */
  envProblem: z.string().nullable(),
  /** Files that could not be read or parsed, and limits that cut the read. */
  problems: z.array(CardProblem),
});
export type AppConfig = z.infer<typeof AppConfig>;
