import { invoke } from "@tauri-apps/api/core";
import { inDesktopShell } from "@/lib/app-window";

const COPY_TEXT_COMMAND = "copy_text";

/**
 * Puts text in the system clipboard. In the Tauri window through the shell (`copy_text` in
 * `apps/desktop/src-tauri/src/clipboard.rs`), because WKWebView on macOS refuses `navigator.clipboard` outside a key
 * or click handler, and a copy a program asks for (OSC 52) arrives later, over the WebSocket. In a browser, where there
 * is no shell, `navigator.clipboard`.
 */
export function copyText(text: string): Promise<void> {
  return inDesktopShell() ? invoke(COPY_TEXT_COMMAND, { text }) : navigator.clipboard.writeText(text);
}
