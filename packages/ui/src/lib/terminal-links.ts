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

/** Candidates only: the shell decides what a link means. The id ends on a letter or digit, so a full stop or comma
 * after a link in a sentence is not part of it. */
const LINK = new RegExp(`${TRACKWALL_LINK_SCHEME}://[A-Za-z]+/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?/?`, "g");

/**
 * The links in one terminal row, with the index of their first character. When the row `continues` on the next one
 * (a wrapped line), a link that reaches its end is cut off, so it is left out instead of opening a shorter id.
 */
export function findTrackwallLinks(line: string, continues: boolean): { index: number; text: string }[] {
  return [...line.matchAll(LINK)]
    .filter((match) => !(continues && match.index + match[0].length === line.length))
    .map((match) => ({ index: match.index, text: match[0] }));
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
      const text = buffer.getLine(y - 1)?.translateToString() ?? "";
      const links = findTrackwallLinks(text, buffer.getLine(y)?.isWrapped ?? false).map((link) => ({
        text: link.text,
        range: { start: { x: link.index + 1, y }, end: { x: link.index + link.text.length, y } },
        activate: (event: MouseEvent, url: string) => {
          if (!opensLink(event, mac)) return;
          invoke(OPEN_LINK_COMMAND, { url }).catch((err: unknown) => console.error("[jump] could not open the link", err));
        },
      }));
      callback(links.length > 0 ? links : undefined);
    },
  };
}
