import { invoke, isTauri } from "@tauri-apps/api/core";
import { TRACKWALL_LINK_SCHEME } from "@trackwall/protocol";
import type { ILinkProvider, Terminal } from "@xterm/xterm";

/**
 * `trackwall://` links in a session terminal (ADR-52): an agent that points the user at a repo, session or task
 * prints the link in its answer, and Ctrl+click (Cmd+click on macOS) opens it in this window. A plain click stays with
 * Copilot CLI, which takes the mouse. The shell checks the link with the same rules as a link from outside
 * (`open_link` in `apps/desktop/src-tauri/src/link.rs`); outside the Tauri window there is no shell, so nothing opens.
 */
const OPEN_LINK_COMMAND = "open_link";

/** Candidates only: the shell decides what a link means. A wrapped link is found only on its first line. */
const LINK = new RegExp(`${TRACKWALL_LINK_SCHEME}://[A-Za-z]+/[A-Za-z0-9._-]+/?`, "g");

/** The links in one line of text, with the index of their first character. */
export function findTrackwallLinks(line: string): { index: number; text: string }[] {
  return [...line.matchAll(LINK)].map((match) => ({ index: match.index, text: match[0] }));
}

/** Ctrl+click on Windows, Cmd+click on macOS, like links in the VS Code terminal. */
export function opensLink(event: Pick<MouseEvent, "ctrlKey" | "metaKey">, mac: boolean): boolean {
  return mac ? event.metaKey : event.ctrlKey;
}

/** Underlines `trackwall://` links in the terminal and opens them on Ctrl+click or Cmd+click. */
export function trackwallLinkProvider(terminal: Terminal, mac: boolean): ILinkProvider {
  return {
    provideLinks(y, callback) {
      // Columns are counted as characters: an id is ASCII, but wide characters before it on the line shift it.
      const text = terminal.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
      const links = findTrackwallLinks(text).map((link) => ({
        text: link.text,
        range: { start: { x: link.index + 1, y }, end: { x: link.index + link.text.length, y } },
        activate: (event: MouseEvent, url: string) => {
          if (opensLink(event, mac) && isTauri()) void invoke(OPEN_LINK_COMMAND, { url });
        },
      }));
      callback(links.length > 0 ? links : undefined);
    },
  };
}
