import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, TRACKWALL_LINK_SCHEME } from "@trackwall/protocol";
import type { ILinkHandler, ILinkProvider, Terminal } from "@xterm/xterm";

/**
 * `trackwall://` links in a session terminal (ADR-52): an agent that points the user at a repo, session or task
 * prints the link in its answer, and Ctrl+click (Cmd+click on macOS) opens it in this window. A plain click stays with
 * Copilot CLI, which takes the mouse. The shell checks the link with the same rules as a link from outside
 * (`open_link` in `apps/desktop/src-tauri/src/link.rs`); outside the Tauri window there is no shell, so links are not
 * underlined at all. A link reaches the terminal in two forms: as text (`trackwallLinkProvider`), or as a hyperlink
 * whose label is other text (OSC 8), which is how Copilot CLI shows a Markdown link like `[orders](trackwall://…)`
 * (`hyperlinkHandler`).
 */
const OPEN_LINK_COMMAND = "open_link";

/** Candidates only: the shell decides what a link means. The id does not end on a full stop, so the one ending a
 * sentence is not part of it (a `RepoId` may end on `_` or `-`, which no sentence does). */
const LINK = new RegExp(`${TRACKWALL_LINK_SCHEME}://[A-Za-z]+/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?/?`, "g");
const SCHEME_PREFIX = `${TRACKWALL_LINK_SCHEME}://`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_START = /^[0-9a-f-]{0,35}$/i;
/** Indentation and box borders that Copilot CLI puts at the start or the end of a row of its answer. */
const ROW_START = /^[\s│┃|]*/;
const ROW_END = /[\s│┃|]*$/;
const LAST_WORD = /[^\s│┃|]*$/;
/** The longest link (`trackwall://repo/` with a 64-character `RepoId` and a slash) is 82 characters, and every row it
 * covers holds at least one of them, so a link that covers a row starts and ends at most this many rows from it. */
const LINK_REACH = 81;

/** One terminal row: its text, and whether it continues the row above (xterm wrapped it, `IBufferLine.isWrapped`). */
export interface TerminalRow {
  text: string;
  wrapped: boolean;
}

/** A link and where it lies: one part for each row it covers, `row` counted from the first row passed in. */
export interface FoundLink {
  text: string;
  parts: { row: number; start: number; end: number }[];
}

/**
 * The links in `rows`, also those split over several rows. A row xterm wrapped continues the one above it as it is. An
 * unwrapped row continues the one above only after a link cut where nothing else could follow (in the scheme or kind,
 * right after the kind, or inside a session or task UUID), and then without its indentation, because Copilot CLI
 * breaks long words of its answer into indented rows itself. A session or task link whose id is not a whole UUID is
 * left out instead of opening a shorter id.
 */
export function findTrackwallLinks(rows: readonly TerminalRow[]): FoundLink[] {
  const found: FoundLink[] = [];
  let text = "";
  let places: { row: number; index: number }[] = [];
  const flush = () => {
    for (const match of text.matchAll(LINK)) {
      if (validLink(match[0])) found.push({ text: match[0], parts: partsOf(places.slice(match.index, match.index + match[0].length)) });
    }
  };
  for (const [r, row] of rows.entries()) {
    const indent = ROW_START.exec(row.text)?.[0].length ?? 0;
    const afterCut = !row.wrapped && indent < row.text.length && cutLink(lastWord(text));
    if (afterCut) {
      const kept = text.replace(ROW_END, "").length;
      text = text.slice(0, kept);
      places = places.slice(0, kept);
    } else if (!row.wrapped) {
      flush();
      text = "";
      places = [];
    }
    const from = afterCut ? indent : 0;
    text += row.text.slice(from);
    for (let index = from; index < row.text.length; index++) places.push({ row: r, index });
  }
  flush();
  return found;
}

function lastWord(text: string): string {
  return LAST_WORD.exec(text.replace(ROW_END, ""))?.[0] ?? "";
}

/** The end of a row that can only be the start of a longer link. A cut repo id can be whole, so it does not count. */
function cutLink(word: string): boolean {
  const lower = word.toLowerCase();
  if (lower === "") return false;
  if (!lower.startsWith(SCHEME_PREFIX)) return SCHEME_PREFIX.startsWith(lower);
  const [kind = "", id, ...more] = lower.slice(SCHEME_PREFIX.length).split("/");
  if (id === undefined) return /^[a-z]*$/.test(kind);
  if (more.length > 0) return false;
  return id === "" || ((kind === "session" || kind === "task") && UUID_START.test(id) && !UUID.test(id));
}

/** A session or task id must be a whole UUID; a repo id is checked by the UI like any other link (`RepoId`). */
function validLink(link: string): boolean {
  const [kind = "", id = ""] = link.slice(SCHEME_PREFIX.length).replace(/\/$/, "").toLowerCase().split("/");
  return (kind !== "session" && kind !== "task") || UUID.test(id);
}

function partsOf(places: readonly { row: number; index: number }[]): FoundLink["parts"] {
  const parts: FoundLink["parts"] = [];
  for (const { row, index } of places) {
    const last = parts.at(-1);
    if (last?.row === row) last.end = index;
    else parts.push({ row, start: index, end: index });
  }
  return parts;
}

/** Ctrl+click on Windows, Cmd+click on macOS, like links in the VS Code terminal. */
export function opensLink(event: Pick<MouseEvent, "ctrlKey" | "metaKey">, mac: boolean): boolean {
  return mac ? event.metaKey : event.ctrlKey;
}

/** What a hyperlink (OSC 8) in a session terminal opens: a Trackwall link in this window, an `http` or `https`
 * address in the system browser through the daemon (`open-link`, like a README link, ADR-35), anything else nothing. */
export function hyperlinkTarget(uri: string): { kind: "trackwall" | "external"; url: string } | undefined {
  if (uri.toLowerCase().startsWith(`${TRACKWALL_LINK_SCHEME}://`)) return { kind: "trackwall", url: uri };
  const external = ExternalLink.safeParse(uri);
  return external.success ? { kind: "external", url: external.data } : undefined;
}

/** Opens hyperlinks (OSC 8) on Ctrl+click or Cmd+click. xterm.js on its own opens only `http` and `https` ones, with a
 * browser confirmation and `window.open`, which does not reach the system browser from the Tauri window. */
export function hyperlinkHandler(mac: boolean, openExternal: (url: string) => void): ILinkHandler {
  return {
    allowNonHttpProtocols: true,
    activate: (event, uri) => {
      const target = hyperlinkTarget(uri);
      if (!target || !opensLink(event, mac)) return;
      if (target.kind === "external") return openExternal(target.url);
      openTrackwallLink(target.url);
    },
  };
}

function openTrackwallLink(url: string): void {
  invoke(OPEN_LINK_COMMAND, { url }).catch((err: unknown) => console.error("[jump] could not open the link", err));
}

/** Underlines `trackwall://` links in the terminal and opens them on Ctrl+click or Cmd+click; only in the Tauri window.
 * A link split over rows is one link for each row it covers, so the underline stays on its own characters and leaves
 * out the indentation and borders between them. */
export function trackwallLinkProvider(terminal: Terminal, mac: boolean): ILinkProvider {
  return {
    provideLinks(y, callback) {
      // Columns are counted as characters: an id is ASCII, but wide characters before it on the row shift it (§5.4).
      const buffer = terminal.buffer.active;
      const top = Math.max(1, y - LINK_REACH);
      const rows: TerminalRow[] = [];
      for (let line = top; line <= y + LINK_REACH; line++) {
        const at = buffer.getLine(line - 1);
        if (!at) break;
        rows.push({ text: at.translateToString(), wrapped: at.isWrapped });
      }
      const links = findTrackwallLinks(rows).flatMap((link) =>
        link.parts
          .filter((part) => top + part.row === y)
          .map((part) => ({
            text: link.text,
            range: { start: { x: part.start + 1, y }, end: { x: part.end + 1, y } },
            activate: (event: MouseEvent, url: string) => {
              if (opensLink(event, mac)) openTrackwallLink(url);
            },
          })),
      );
      callback(links.length > 0 ? links : undefined);
    },
  };
}
