import { invoke } from "@tauri-apps/api/core";
import { TRACKWALL_LINK_SCHEME } from "@trackwall/protocol";
import type { ILinkProvider, Terminal } from "@xterm/xterm";

/**
 * `trackwall://` links in a session terminal (ADR-52): an agent that points the user at a repo, session or task
 * prints the link in its answer, and Ctrl+click (Cmd+click on macOS) opens it in this window. A plain click stays with
 * Copilot CLI, which takes the mouse. The shell checks the link with the same rules as a link from outside
 * (`open_link` in `apps/desktop/src-tauri/src/link.rs`); outside the Tauri window there is no shell, so links are not
 * underlined at all.
 */
const OPEN_LINK_COMMAND = "open_link";

/** Candidates only: the shell decides what a link means. The id does not end on a full stop, so the one ending a
 * sentence is not part of it (a `RepoId` may end on `_` or `-`, which no sentence does). */
const LINK = new RegExp(`${TRACKWALL_LINK_SCHEME}://[A-Za-z]+/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?/?`, "g");
const LINK_AT_START = new RegExp(`^(?:${LINK.source})`);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_START = /^[0-9a-f-]{1,35}$/i;
const UUID_PART = /^[0-9a-f-]*/i;
/** Indentation and box borders that Copilot CLI puts at the start or the end of a row of its answer. */
const ROW_START = /^[\s│┃|]*/;
const ROW_END = /[\s│┃|]*$/;
/** How many rows after the first a link may continue on: a task link is 53 characters, so even a narrow grid tile
 * splits it into at most three rows. */
const LINK_ROWS = 3;

/** One terminal row: its text, and whether it continues the row above (xterm wrapped it, `IBufferLine.isWrapped`). */
export interface TerminalRow {
  text: string;
  wrapped: boolean;
}

/** A link with its first and last character; `row` counts from the first row passed in. */
export interface FoundLink {
  text: string;
  start: { row: number; index: number };
  end: { row: number; index: number };
}

/**
 * The links that start in `rows[0]`, joined across the rows below it when they continue there. A link continues on a
 * row xterm wrapped, and a session or task link whose UUID is cut also continues after the indentation of the next
 * row, because Copilot CLI breaks long words of its answer into rows itself. A UUID that stays cut is left out
 * instead of opening a shorter id.
 */
export function findTrackwallLinks(rows: readonly TerminalRow[]): FoundLink[] {
  const [first, ...below] = rows;
  if (!first) return [];
  const found: FoundLink[] = [];
  for (const match of first.text.matchAll(LINK)) {
    const link = { text: match[0], start: { row: 0, index: match.index }, end: { row: 0, index: match.index + match[0].length - 1 } };
    const whole = reachesRowEnd(first.text, link.end.index) ? continued(link, below) : link;
    if (!cutUuid(whole.text)) found.push(whole);
  }
  return found;
}

function reachesRowEnd(text: string, last: number): boolean {
  return last + 1 === text.length - (ROW_END.exec(text)?.[0].length ?? 0);
}

/** The link joined with the rows it continues on. */
function continued(link: FoundLink, below: readonly TerminalRow[]): FoundLink {
  let current = link;
  for (const [offset, row] of below.entries()) {
    if (!row.wrapped && !cutUuid(current.text)) break;
    // An unwrapped row continues only a cut UUID, so only UUID characters are taken from it.
    const from = row.wrapped ? 0 : (ROW_START.exec(row.text)?.[0].length ?? 0);
    const rest = row.wrapped ? row.text.slice(from) : (UUID_PART.exec(row.text.slice(from))?.[0] ?? "");
    const joined = LINK_AT_START.exec(current.text + rest)?.[0];
    if (!joined || joined.length <= current.text.length) break;
    const last = from + joined.length - current.text.length - 1;
    current = { text: joined, start: current.start, end: { row: offset + 1, index: last } };
    if (!reachesRowEnd(row.text, last)) break;
  }
  return current;
}

/** A session or task link whose id is only the start of a UUID. */
function cutUuid(link: string): boolean {
  const [kind, id = ""] = link.slice(`${TRACKWALL_LINK_SCHEME}://`.length).replace(/\/$/, "").split("/");
  return (kind === "session" || kind === "task") && !UUID.test(id) && UUID_START.test(id);
}

/** Ctrl+click on Windows, Cmd+click on macOS, like links in the VS Code terminal. */
export function opensLink(event: Pick<MouseEvent, "ctrlKey" | "metaKey">, mac: boolean): boolean {
  return mac ? event.metaKey : event.ctrlKey;
}

/** Underlines `trackwall://` links in the terminal and opens them on Ctrl+click or Cmd+click; only in the Tauri window. */
export function trackwallLinkProvider(terminal: Terminal, mac: boolean): ILinkProvider {
  return {
    provideLinks(y, callback) {
      // Columns are counted as characters: an id is ASCII, but wide characters before it on the row shift it (§5.4).
      const buffer = terminal.buffer.active;
      const row = (line: number): TerminalRow | undefined => {
        const at = buffer.getLine(line - 1);
        return at && { text: at.translateToString(), wrapped: at.isWrapped };
      };
      const links = [];
      // A link that covers row `y` may start on one of the rows above it.
      for (let top = Math.max(1, y - LINK_ROWS + 1); top <= y; top++) {
        const rows = Array.from({ length: LINK_ROWS }, (_, i) => row(top + i)).filter((r) => r !== undefined);
        for (const link of findTrackwallLinks(rows)) {
          if (top + link.end.row < y) continue;
          links.push({
            text: link.text,
            range: { start: { x: link.start.index + 1, y: top }, end: { x: link.end.index + 1, y: top + link.end.row } },
            activate: (event: MouseEvent, url: string) => {
              if (!opensLink(event, mac)) return;
              invoke(OPEN_LINK_COMMAND, { url }).catch((err: unknown) => console.error("[jump] could not open the link", err));
            },
          });
        }
      }
      callback(links.length > 0 ? links : undefined);
    },
  };
}
