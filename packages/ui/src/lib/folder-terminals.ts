import type { FolderTerminal, TerminalPlace } from "@trackwall/protocol";
import { createContext } from "react";
import type { LiveFeed } from "./daemon-events.ts";

/**
 * Folder terminals (ADR-185) on the UI side: the list comes live from the events WebSocket, which `App` provides here,
 * so a repo's or a task's Shell tab finds its terminal without a prop through every view between them.
 */
export const FolderTerminalsLive = createContext<LiveFeed<FolderTerminal[]> | undefined>(undefined);

/** The terminal of a place, if it has one: one place has at most one (the daemon hands back the live one). */
export function terminalAt(list: readonly FolderTerminal[], place: TerminalPlace): FolderTerminal | undefined {
  return list.find((terminal) => terminal.repo === place.repo && terminal.task === place.task);
}

/**
 * Whether opening the Shell tab starts the place's shell: once per tab, after the list came and showed none. A start
 * already asked for, one that failed, or a shell the user closed waits for the button instead.
 */
export function startsOnOpen(state: { loaded: boolean; hasTerminal: boolean; alreadyAsked: boolean }): boolean {
  return state.loaded && !state.hasTerminal && !state.alreadyAsked;
}

/**
 * How long the Shell tab stays shown before it starts the place's shell. Ctrl+PageUp and Ctrl+PageDown step through the
 * tabs (ADR-211), so passing through Shell on the way to the next tab is routine and must not leave a shell running.
 */
const SHELL_START_PAUSE_MS = 400;

/** Calls `start` once the tab has stayed shown for `ms`; returns the function that cancels it when the tab goes. */
export function startAfterPause(start: () => void, ms: number = SHELL_START_PAUSE_MS): () => void {
  const timer = setTimeout(start, ms);
  return () => clearTimeout(timer);
}
