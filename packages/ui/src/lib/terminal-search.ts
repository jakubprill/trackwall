/**
 * Finding text in a terminal's screen and scrollback (`@xterm/addon-search`). Ctrl+F is a key of the shell (forward a
 * character in readline) and of programs in the terminal, so, as in Windows Terminal, Ctrl+Shift+F opens the search on
 * Windows and Linux; on macOS Cmd+F, which no program in the terminal gets.
 */

type SearchKey = Pick<KeyboardEvent, "type" | "key" | "ctrlKey" | "shiftKey" | "altKey" | "metaKey">;

export function opensSearch(key: SearchKey, { mac }: { mac: boolean }): boolean {
  if (key.type !== "keydown" || key.altKey || key.key.toLowerCase() !== "f") return false;
  return mac ? key.metaKey && !key.ctrlKey : key.ctrlKey && key.shiftKey && !key.metaKey;
}

/** What the search bar does with a key in its field: Enter the next match up, Shift+Enter the one below, Escape closes. */
export function searchKeyAction(key: Pick<KeyboardEvent, "key" | "shiftKey">): "previous" | "next" | "close" | undefined {
  if (key.key === "Escape") return "close";
  if (key.key !== "Enter") return undefined;
  // The newest output is at the bottom, so the first Enter looks up from it, as in VS Code's terminal.
  return key.shiftKey ? "next" : "previous";
}
