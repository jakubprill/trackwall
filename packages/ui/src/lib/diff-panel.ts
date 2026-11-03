import type { ConversationEntry } from "@trackwall/protocol";
import type { ConversationTurn } from "./conversation.ts";
import { type Change, changeLines, DIFF_SHOWN_LINES, diffLines } from "./diff-lines.ts";

/**
 * The diff panel of the conversation view (ADR-107): beside a wide conversation, the files one agent turn changed with
 * the diff of each. It is optional: closed until the user opens a file of a turn, closed again with ✕, and nothing in
 * the conversation waits for it. Each view starts with it closed.
 */

type ToolEntry = Extract<ConversationEntry, { kind: "tool" }>;

/** One file a turn changed: what its tool calls added and removed together, and each call's change in order. */
export interface TurnFile {
  path: string;
  added: number;
  removed: number;
  changes: { tool: string; change: Change }[];
}

/**
 * A tool call's change file by file. Copilot CLI's patch names a file by its absolute path without the leading slash
 * (`a/home/me/shop/src/a.ts`), so a file goes by the name the daemon gave the call (relative to the session's working
 * directory) that the patch's path ends with, and by the patch's path only when no name fits.
 */
export function toolFileChanges(tool: Pick<ToolEntry, "files" | "patch" | "patchCut">): { path: string; change: Change }[] {
  if (tool.patch === "") return [];
  const lines = diffLines(tool.patch, Number.POSITIVE_INFINITY).lines;
  const starts = lines.filter((line) => line.kind === "file").map((line) => line.offset);
  const pieces = starts.length === 0 ? [0] : starts;
  return pieces.map((from, at) => {
    const piece = tool.patch.slice(from, pieces[at + 1] ?? tool.patch.length);
    const cut = tool.patchCut && at === pieces.length - 1;
    const change = changeLines(piece, DIFF_SHOWN_LINES, cut);
    return { path: fileOf(tool.files, change, pieces.length), change };
  });
}

function fileOf(files: readonly string[], change: Change, pieces: number): string {
  const [only] = files;
  if (pieces === 1 && files.length === 1 && only !== undefined) return only;
  const path = change.lines.find((line) => line.anchor !== null)?.anchor?.path;
  if (path === undefined) return files.join(", ");
  return files.find((file) => path.endsWith(file.replaceAll("\\", "/"))) ?? path;
}

/** The files a turn's tool calls changed, in the order the turn first changed them. */
export function turnFiles(steps: readonly ConversationEntry[]): TurnFile[] {
  const files = new Map<string, TurnFile>();
  for (const step of steps) {
    if (step.kind !== "tool") continue;
    for (const { path, change } of toolFileChanges(step)) {
      const file = files.get(path) ?? { path, added: 0, removed: 0, changes: [] };
      file.added += change.added;
      file.removed += change.removed;
      file.changes.push({ tool: step.id, change });
      files.set(path, file);
    }
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
