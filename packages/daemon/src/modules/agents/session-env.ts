import type { SessionEnvironment } from "@trackwall/protocol";
import { envKey } from "../../infra/env-key.ts";
import { valuesNamed } from "../../infra/secret-name.ts";

/**
 * The environment of a session's Copilot CLI with what mise sets in its place (ADR-93), so the agent, its shell and the
 * MCP servers Copilot CLI starts get the variables and tools the user's terminal gets there. Secrets reach those tools
 * only when the user names them in `agentSecrets`; Copilot CLI hides the rest (`--secret-env-vars`), and the daemon masks
 * them all in what it keeps.
 */

/** A name Copilot CLI's comma-separated list can carry. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** What mise sets for a session (`mise` module, wired in the facade). */
export interface SessionMiseEnv {
  vars: Record<string, string>;
  secretNames: string[];
  /** Why the session got less than its place gives; `null` when nothing is missing. */
  problem: string | null;
}

/** The user's environment with mise's variables over it, each under the user's spelling of its name (`Path` on Windows). */
export function withMiseVars(env: NodeJS.ProcessEnv, vars: Record<string, string>): NodeJS.ProcessEnv {
  const merged = { ...env };
  for (const [name, value] of Object.entries(vars)) merged[envKey(merged, name)] = value;
  return merged;
}

/**
 * The secrets hidden from the session's tools: mise's secrets except the ones the user gives agents (`agentSecrets`), sorted
 * so the argument does not change between starts. Copilot CLI keeps them out of its shell commands and the MCP servers it
 * starts, not only out of their output (contract test); a name its comma-separated list cannot carry is left out, but
 * the daemon still masks its value. The user's own environment stays as it is.
 */
export function hiddenSecrets(mise: SessionMiseEnv, agentSecrets: readonly string[]): string[] {
  return mise.secretNames.filter((name) => !agentSecrets.includes(name) && VARIABLE_NAME.test(name)).sort();
}

/** Copilot CLI's argument for the hidden secrets (comma-separated names); none without them. */
export function secretEnvVarsArgs(names: readonly string[]): string[] {
  return names.length === 0 ? [] : [`--secret-env-vars=${names.join(",")}`];
}

/** The values of mise's secrets, which the daemon masks in what it keeps of the session's screen. */
export function miseSecretValues(mise: SessionMiseEnv): string[] {
  return valuesNamed(mise.vars, mise.secretNames);
}

/** What the session shows of its environment: names only, never values. */
export function sessionEnvironment(mise: SessionMiseEnv, hidden: readonly string[]): SessionEnvironment {
  const secrets = [...mise.secretNames].sort();
  return {
    variables: Object.keys(mise.vars).sort(),
    secrets,
    agentSecrets: secrets.filter((name) => !hidden.includes(name)),
    problem: mise.problem,
  };
}
