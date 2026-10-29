import { countLabel, type SessionEnvironment } from "@trackwall/protocol";

/**
 * What the session panel and a grid tile say about the environment a session got from mise (ADR-93): only names,
 * never values. The secrets the agent's tools get (`agentSecrets`) are listed apart from those Copilot CLI hides from
 * them and from the plain variables, so the user sees why a tool lacks a token. Null when mise gave the session
 * nothing and nothing went wrong.
 */
export interface SessionEnvironmentLines {
  summary: string;
  /** For the tile's badge: the summary, and that the session got less than its place gives. */
  badgeLabel: string;
  count: number;
  shared: readonly string[];
  hidden: readonly string[];
  /** The variables that are not secrets. */
  other: readonly string[];
  problem: string | null;
}

export function sessionEnvironmentLines(environment: SessionEnvironment): SessionEnvironmentLines | null {
  const { variables, secrets, agentSecrets, problem } = environment;
  if (variables.length === 0 && problem === null) return null;
  const summary = `${countLabel(variables.length, { one: "variable", other: "variables" })} from mise`;
  return {
    summary,
    badgeLabel: problem === null ? summary : `${summary}, some are missing`,
    count: variables.length,
    shared: agentSecrets,
    hidden: secrets.filter((name) => !agentSecrets.includes(name)),
    other: variables.filter((name) => !secrets.includes(name)),
    problem,
  };
}

/**
 * The environment card on a grid tile (ADR-93): hovering the badge shows it, clicking pins it until another click or
 * Escape, and leaving the badge and the card hides it only while it is not pinned.
 */
export interface EnvironmentCardState {
  open: boolean;
  pinned: boolean;
}

export type EnvironmentCardEvent = "hover" | "leave" | "click" | "escape";

export const ENVIRONMENT_CARD_CLOSED: EnvironmentCardState = { open: false, pinned: false };

export function nextEnvironmentCard(state: EnvironmentCardState, event: EnvironmentCardEvent): EnvironmentCardState {
  switch (event) {
    case "hover":
      return { ...state, open: true };
    case "leave":
      return state.pinned ? state : ENVIRONMENT_CARD_CLOSED;
    case "click":
      return state.pinned ? ENVIRONMENT_CARD_CLOSED : { open: true, pinned: true };
    case "escape":
      return ENVIRONMENT_CARD_CLOSED;
  }
}
