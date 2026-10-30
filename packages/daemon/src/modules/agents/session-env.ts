import { ENV_VARIABLE_NAME, type SessionEnvironment } from "@trackwall/protocol";
import { envKey } from "../../infra/env-key.ts";

/**
 * The environment of a session's Copilot CLI with what mise sets in its place (ADR-93), so the agent, its shell and the
 * MCP servers Copilot CLI starts get the variables and tools the user's terminal gets there. Secrets reach the shell and
 * the local MCP servers only when the user names them in `agentSecrets`; Copilot CLI removes the rest from their
 * environment (`--secret-env-vars`, the shell checked by a contract test), and the daemon masks them all in what it keeps.
 * This keeps a secret from slipping into a command by accident; it does not stop an agent that runs `mise env` itself (§8).
 */

/** What mise sets for a session (`mise` module, wired in the facade). */
export interface SessionMiseEnv {
  vars: Record<string, string>;
  secretNames: string[];
  secretValues: string[];
  /** Why the session got less than its place gives; `null` when nothing is missing. */
  problem: string | null;
  /** The session profile mise read the environment with (ADR-136); `null` without one. */
  profile: string | null;
}

/** mise's age key in the user's own environment decrypts every secret, so the agent's tools never get it unasked. */
const AGE_KEY_ENV = "MISE_AGE_KEY";

/** What a session starts with: its environment, Copilot CLI's argument hiding secrets, the values to mask, the names it shows. */
export interface SessionMiseLaunch {
  env: NodeJS.ProcessEnv;
  args: string[];
  secretValues: string[];
  environment: SessionEnvironment;
}

export function sessionMiseLaunch(mise: SessionMiseEnv, userEnv: NodeJS.ProcessEnv, agentSecrets: readonly string[]): SessionMiseLaunch {
  // A secret Copilot CLI's list cannot name would reach the tools unhidden, so the session goes without it.
  const unhideable = mise.secretNames.filter((name) => !ENV_VARIABLE_NAME.test(name));
  const vars = Object.fromEntries(Object.entries(mise.vars).filter(([name]) => !unhideable.includes(name)));
  const env = withMiseVars(userEnv, vars);
  const secrets = mise.secretNames.filter((name) => !unhideable.includes(name)).sort();
  const ageKey = env[envKey(env, AGE_KEY_ENV)] === undefined ? [] : [AGE_KEY_ENV];
  const hidden = [...new Set([...secrets, ...ageKey])]
    .filter((name) => !agentSecrets.includes(name))
    // The spelling Copilot CLI finds in its environment (`Path` on Windows), which may be the user's rather than mise's.
    .map((name) => envKey(env, name))
    .sort();
  const problems = [
    mise.problem,
    ...unhideable.map((name) => `${name} from mise is left out: Copilot CLI cannot hide a variable with that name`),
  ];
  return {
    env,
    args: hidden.length === 0 ? [] : [`--secret-env-vars=${hidden.join(",")}`],
    secretValues: mise.secretValues,
    environment: {
      variables: Object.keys(vars).sort(),
      secrets,
      agentSecrets: secrets.filter((name) => agentSecrets.includes(name)),
      profile: mise.profile,
      problem: problems.filter((line) => line !== null).join("\n") || null,
    },
  };
}

/** The user's environment with mise's variables over it, each under the user's spelling of its name (`Path` on Windows). */
export function withMiseVars(env: NodeJS.ProcessEnv, vars: Record<string, string>): NodeJS.ProcessEnv {
  const merged = { ...env };
  for (const [name, value] of Object.entries(vars)) merged[envKey(merged, name)] = value;
  return merged;
}
