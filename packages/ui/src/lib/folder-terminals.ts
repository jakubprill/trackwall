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
 * Whether opening the Shell tab asks the daemon for the place's shell: once per tab, and only when a live shell is
 * already there, so that the daemon can swap a projects folder shell left in the old folder for one in the new
 * (ADR-185). A place without a live shell waits for "Open a shell": a shell starts only when the user asks (ADR-211).
 */
export function reopensOnOpen(state: { loaded: boolean; hasLiveShell: boolean; alreadyAsked: boolean }): boolean {
  return state.loaded && state.hasLiveShell && !state.alreadyAsked;
}

/**
 * The terminal a Shell tab shows: the list's, or until the list has it the start's own answer, but never one the tab
 * asked to close. A close hides the shell at once and the daemon ends it in the background, so the tab offers a new
 * shell while the old one is still ending, also while the list still names the old one for a moment.
 */
export function shownTerminal(state: {
  listed: FolderTerminal | undefined;
  started: FolderTerminal | undefined;
  closing: ReadonlySet<string>;
}): FolderTerminal | undefined {
  return [state.listed, state.started].find((terminal) => terminal !== undefined && !state.closing.has(terminal.id));
}
