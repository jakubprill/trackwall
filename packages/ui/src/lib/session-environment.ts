import { countLabel, type SessionEnvironment } from "@trackwall/protocol";
import type { Timers } from "./timers.ts";

/**
 * What the session panel and a grid tile say about the environment a session got from mise (ADR-93): only names,
 * never values. The secrets the agent's tools get (`agentSecrets`) are listed apart from those Copilot CLI hides from
 * them and from the plain variables, so the user sees why a tool lacks a token, and the summary names the session
 * profile it started with (ADR-136). Null when mise gave the session nothing, without a profile, and nothing went wrong.
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
  const { variables, secrets, agentSecrets, problem, profile } = environment;
  if (variables.length === 0 && problem === null && profile === null) return null;
  const counted = `${countLabel(variables.length, { one: "variable", other: "variables" })} from mise`;
  const summary = profile === null ? counted : `${counted}, profile ${profile}`;
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

/** What a grid tile's environment badge and card show (ADR-93, ADR-178). */
export interface TileEnvironment {
  /** Yellow: the session got less than its place gives, or it started with another session profile. */
  warn: boolean;
  label: string;
  /** The number on the badge; `null` when mise gave the session nothing and only the profile changed. */
  count: number | null;
  summary: string;
  /** What the card says before the names: the profile change, then why the session got less. */
  notes: string[];
}

/** The tile's environment from the panel's lines and the profile note (`profileChange`); `null` shows no badge. */
export function tileEnvironment(lines: SessionEnvironmentLines | null, profileNote: string | null): TileEnvironment | null {
  if (lines === null && profileNote === null) return null;
  const notes = [profileNote && `${profileNote}. Open the session to restart it.`, lines?.problem ?? null];
  return {
    warn: (lines?.problem ?? null) !== null || profileNote !== null,
    label: [lines?.badgeLabel ?? "no variables", profileNote && "the session profile changed"].filter(Boolean).join(", "),
    count: lines?.count ?? null,
    summary: lines?.summary ?? "No variables from mise",
    notes: notes.filter((note): note is string => Boolean(note)),
  };
}

/** The card waits a moment before it shows on hover and before it hides, so that passing the mouse over does nothing. */
export const HOVER_OPEN_MS = 250;
export const HOVER_CLOSE_MS = 200;

export interface EnvironmentCardState {
  open: boolean;
  pinned: boolean;
}

export const ENVIRONMENT_CARD_CLOSED: EnvironmentCardState = { open: false, pinned: false };

/**
 * The environment card on a grid tile (ADR-93): hovering the badge or the card shows it after a moment, leaving both
 * hides it after a moment unless a click pinned it, and a second click or Escape closes it at once. Moving from the
 * badge to the card keeps it open, since entering the card cancels the pending hide.
 */
export class EnvironmentCard<Timer> {
  readonly #onChange: (state: EnvironmentCardState) => void;
  readonly #timers: Timers<Timer>;
  #timer: Timer | undefined;
  #state = ENVIRONMENT_CARD_CLOSED;

  constructor(onChange: (state: EnvironmentCardState) => void, timers: Timers<Timer>) {
    this.#onChange = onChange;
    this.#timers = timers;
  }

  enter(): void {
    this.#cancel();
    if (!this.#state.open) this.#later({ open: true, pinned: false }, HOVER_OPEN_MS);
  }

  leave(): void {
    this.#cancel();
    if (this.#state.open && !this.#state.pinned) this.#later(ENVIRONMENT_CARD_CLOSED, HOVER_CLOSE_MS);
  }

  click(): void {
    this.#set(this.#state.pinned ? ENVIRONMENT_CARD_CLOSED : { open: true, pinned: true });
  }

  /** Escape, or the session no longer has an environment to show. */
  close(): void {
    this.#set(ENVIRONMENT_CARD_CLOSED);
  }

  dispose(): void {
    this.#cancel();
  }

  #later(state: EnvironmentCardState, ms: number): void {
    this.#timer = this.#timers.set(() => {
      this.#timer = undefined;
      this.#set(state);
    }, ms);
  }

  #set(state: EnvironmentCardState): void {
    this.#cancel();
    this.#state = state;
    this.#onChange(state);
  }

  #cancel(): void {
    if (this.#timer !== undefined) this.#timers.clear(this.#timer);
    this.#timer = undefined;
  }
}
