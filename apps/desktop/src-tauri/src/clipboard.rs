//! Writing the system clipboard for the window (ADR-51). An app command that can only write text, never read it, so
//! the page gets no clipboard access of its own. The page needs it because WKWebView on macOS refuses
//! `navigator.clipboard` outside a key or click handler, and a copy that Copilot CLI asks for in a session terminal
//! (OSC 52) arrives later, over the WebSocket.

/// More than a screen's scrollback; a longer text is a mistake or an attack, not a copy.
const MAX_TEXT_BYTES: usize = 1 << 20;

#[tauri::command]
pub fn copy_text(text: String) -> Result<(), String> {
    if text.len() > MAX_TEXT_BYTES {
        return Err(format!("the text to copy is {} bytes, more than {MAX_TEXT_BYTES}", text.len()));
    }
    arboard::Clipboard::new().and_then(|mut clipboard| clipboard.set_text(text)).map_err(|e| e.to_string())
}
