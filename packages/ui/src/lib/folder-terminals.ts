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
