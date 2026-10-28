import { countLabel, type SessionEnvironment } from "@trackwall/protocol";

/**
 * What the session panel says about the environment a session got from mise (ADR-93): only names, never values. The
 * secrets the agent's tools do not get are listed apart from those `agentSecrets` lets through, so the user sees why a
 * tool lacks a token. Null when mise gave the session nothing and nothing went wrong.
 */
export interface SessionEnvironmentLines {
  summary: string;
  /** Every variable name, for the tooltip. */
  names: string;
  hidden: readonly string[];
  shared: readonly string[];
  problem: string | null;
}

export function sessionEnvironmentLines(environment: SessionEnvironment): SessionEnvironmentLines | null {
  const { variables, secrets, agentSecrets, problem } = environment;
  if (variables.length === 0 && problem === null) return null;
  const hidden = secrets.filter((name) => !agentSecrets.includes(name));
  return {
    summary: `${countLabel(variables.length, { one: "variable", other: "variables" })} from mise`,
    names: variables.join("\n"),
    hidden,
    shared: agentSecrets,
    problem,
  };
}
