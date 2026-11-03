import type { ConversationEntry } from "@trackwall/protocol";
import { type ConversationTurn, PATCH_SHOWN_LINES } from "./conversation.ts";
import { type Change, changeLines } from "./diff-lines.ts";

/**
 * The diff panel of the conversation view (ADR-107): beside a wide conversation, the files one agent turn changed with
 * the diff of each. It is optional: closed until the user opens a file of a turn, closed again with ✕, and nothing in
 * the conversation waits for it. This browser profile remembers whether it is open, like the supervisor's view.
 */

type ToolEntry = Extract<ConversationEntry, { kind: "tool" }>;

/** One file a turn changed: what its tool calls added and removed together, and each call's change in order. */
export interface TurnFile {
  path: string;
  added: number;
  removed: number;
  changes: { tool: string; change: Change }[];
}

/** The file of a tool call's change: its one file, or what it names when it has several or none. */
export function changedFile(tool: Pick<ToolEntry, "files" | "title">): string {
  return tool.files.length > 0 ? tool.files.join(", ") : tool.title;
}

/** The files a turn's tool calls changed, in the order the turn first changed them; a call without a patch changed none. */
export function turnFiles(steps: readonly ConversationEntry[]): TurnFile[] {
  const files = new Map<string, TurnFile>();
  for (const step of steps) {
    if (step.kind !== "tool" || step.patch === "") continue;
    const change = changeLines(step.patch, PATCH_SHOWN_LINES, step.patchCut);
    const path = changedFile(step);
    const file = files.get(path) ?? { path, added: 0, removed: 0, changes: [] };
    file.added += change.added;
    file.removed += change.removed;
    file.changes.push({ tool: step.id, change });
    files.set(path, file);
  }
  return [...files.values()];
}

/** A file the user picked: the agent turn (its id) and the file's path. */
export interface DiffPick {
  turn: string;
  path: string;
}

/** What the open panel shows: one turn's files and which of them, or `null` while no turn has changed a file. */
export interface DiffShown {
  turn: string;
  files: TurnFile[];
  file: TurnFile;
}

/**
 * The picked file of the picked turn; without a pick, or once it is gone (a reset of the conversation), the last turn
 * that changed a file, with its first file.
 */
export function shownDiff(turns: readonly ConversationTurn[], pick: DiffPick | null): DiffShown | null {
  const agentTurns = turns.filter((turn) => turn.kind === "agent");
  const picked = pick ? agentTurns.find((turn) => turn.id === pick.turn) : undefined;
  if (picked) {
    const files = turnFiles(picked.steps);
    const file = files.find((f) => f.path === pick?.path) ?? files[0];
    if (file) return { turn: picked.id, files, file };
  }
  for (const turn of [...agentTurns].reverse()) {
    const files = turnFiles(turn.steps);
    const [file] = files;
    if (file) return { turn: turn.id, files, file };
  }
  return null;
}

const OPEN_KEY = "trackwall.conversation.diffPanel";

/** Closed unless the user left it open; a storage failure reads as closed. */
export function readDiffPanelOpen(storage: () => Pick<Storage, "getItem">): boolean {
  try {
    return storage().getItem(OPEN_KEY) === "open";
  } catch {
    return false;
  }
}

export function saveDiffPanelOpen(storage: () => Pick<Storage, "setItem">, open: boolean): void {
  try {
    storage().setItem(OPEN_KEY, open ? "open" : "closed");
  } catch {
    // The panel stays as it is in this window; only the next start of the app does not remember it.
  }
}
