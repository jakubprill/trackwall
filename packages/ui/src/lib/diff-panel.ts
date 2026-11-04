import type { ConversationEntry } from "@trackwall/protocol";
import type { ConversationTurn } from "./conversation.ts";
import { type Change, changeLines, DIFF_SHOWN_LINES, type DiffAnchor, diffLines } from "./diff-lines.ts";

/**
 * The diff panel of the conversation view (ADR-107): beside a wide conversation, the files one agent turn changed with
 * the diff of each. It is optional: closed until the user opens a file of a turn, closed again with ✕, and nothing in
 * the conversation waits for it. Each view starts with it closed.
 */

type ToolEntry = Extract<ConversationEntry, { kind: "tool" }>;

/** One file a turn changed: what its tool calls added and removed together, and each call's change in order. */
export interface TurnFile {
  path: string;
  /** The daemon named the file (relative to the working directory), so its lines can be commented on and opened. */
  known: boolean;
  added: number;
  removed: number;
  changes: { tool: string; change: Change }[];
}

/**
 * A tool call's change file by file. Copilot CLI's patch names a file by its absolute path without the leading slash
 * (`a/home/me/shop/src/a.ts`), so a file goes by the name the daemon gave the call (relative to the session's working
 * directory) that the patch's path ends with, and by the patch's path only when no name fits. A file without lines of
 * a change (a binary or a renamed one) is left out, since there is nothing to show of it. A patch in plain `---` and
 * `+++` form, without `diff --git`, stays one piece. Each line's anchor of a file the daemon named takes that name too,
 * so a review comment or VS Code gets the path the daemon knows; another file is `known: false`.
 */
export function toolFileChanges(tool: Pick<ToolEntry, "files" | "patch" | "patchCut">): { path: string; known: boolean; change: Change }[] {
  if (tool.patch === "") return [];
  const lines = diffLines(tool.patch, Number.POSITIVE_INFINITY).lines;
  const starts = lines.filter((line) => line.kind === "file").map((line) => line.offset);
  const pieces = starts.length === 0 ? [0] : starts;
  return pieces
    .map((from, at) => {
      const piece = tool.patch.slice(from, pieces[at + 1] ?? tool.patch.length);
      const cut = tool.patchCut && at === pieces.length - 1;
      const change = changeLines(piece, DIFF_SHOWN_LINES, cut);
      const path = fileOf(tool.files, change, pieces.length);
      const known = tool.files.includes(path) && !isAbsolutePath(path);
      if (!known) return { path, known, change };
      const lines = change.lines.map((line) => (line.anchor ? { ...line, anchor: { ...line.anchor, path } } : line));
      return { path, known, change: { ...change, lines } };
    })
    .filter(({ change }) => change.lines.length > 0);
}

/** A path from the root (`/…`) or a drive (`C:\…`): a file outside the working directory, which the daemon leaves whole. */
function isAbsolutePath(path: string): boolean {
  return /^([/\\]|[A-Za-z]:[/\\])/.test(path);
}

function fileOf(files: readonly string[], change: Change, pieces: number): string {
  const [only] = files;
  if (pieces === 1 && files.length === 1 && only !== undefined) return only;
  const path = change.lines.find((line) => line.anchor !== null)?.anchor?.path;
  if (path === undefined) return files.join(", ") || "a changed file";
  // A whole folder name: `src/a.ts` is not `src/data.ts`.
  return (
    files.find((file) => {
      const name = file.replaceAll("\\", "/");
      return path === name || path.endsWith(`/${name}`);
    }) ?? path
  );
}

/** The files a turn's tool calls changed, in the order the turn first changed them. */
export function turnFiles(steps: readonly ConversationEntry[]): TurnFile[] {
  const files = new Map<string, TurnFile>();
  for (const step of steps) {
    if (step.kind !== "tool") continue;
    for (const { path, known, change } of toolFileChanges(step)) {
      const file = files.get(path) ?? { path, known, added: 0, removed: 0, changes: [] };
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
  /**
   * The tool call whose change of the file is the conversation's last one, when the panel shows it and the daemon named
   * the file: only its lines are numbered as the file is now, for "Comment" and "Open in VS Code".
   */
  current: string | null;
}

/**
 * The picked file of the picked turn; without a pick, or once it is gone (a reset of the conversation), the last turn
 * that changed a file, with its first file.
 */
export function shownDiff(turns: readonly ConversationTurn[], pick: DiffPick | null): DiffShown | null {
  const filesOf = turns.flatMap((turn) => (turn.kind === "agent" ? [{ turn: turn.id, files: turnFiles(turn.steps) }] : []));
  const shown = pickedFile(filesOf, pick);
  if (shown === null) return null;
  const last = filesOf
    .flatMap(({ files }) => files.filter((f) => f.path === shown.file.path))
    .at(-1)
    ?.changes.at(-1)?.tool;
  const current = shown.file.known && shown.file.changes.some((c) => c.tool === last) ? (last ?? null) : null;
  return { ...shown, current };
}

function pickedFile(filesOf: { turn: string; files: TurnFile[] }[], pick: DiffPick | null): Omit<DiffShown, "current"> | null {
  const picked = pick ? filesOf.find(({ turn }) => turn === pick.turn) : undefined;
  const file = picked?.files.find((f) => f.path === pick?.path) ?? picked?.files[0];
  if (picked && file) return { turn: picked.turn, files: picked.files, file };
  const last = filesOf.findLast(({ files }) => files.length > 0);
  const [first] = last?.files ?? [];
  return last && first ? { turn: last.turn, files: last.files, file: first } : null;
}

/**
 * Whether a line of the panel's diff is in the file as the agent left it, which "Comment" (a task's review) and "Open in
 * VS Code" need: a removed line is numbered in the file before that change, not in the task's base commit or the
 * worktree. "Ask about this" takes any line.
 */
export function inFileAsLeft(anchor: DiffAnchor): boolean {
  return anchor.side === "new";
}

/** What "Ask about this" puts in front of the message: the file and line, and the line as a quote. */
export function askAboutLine(anchor: DiffAnchor, diffText: string): string {
  const where = anchor.side === "new" ? `line ${anchor.line}` : `removed line ${anchor.line}`;
  return `About ${anchor.path}, ${where}:\n> ${diffText.slice(1).trim()}\n\n`;
}
