//! The shell's side of Trackwall's error journal (ADR-94): an error of the shell (a call that failed where it used to be
//! only written to stderr, which a release build on Windows has nowhere to show) and a panic go as one JSON line into
//! `logs/shell-errors.jsonl` in the state directory, where the daemon takes them into the journal when it is read. The
//! shell appends and closes the file for each line, so the daemon can rename it away at any moment, and it writes even
//! when no daemon runs. The daemon anonymizes the text; the shell writes what it would have written to stderr.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// The file's name in the state directory's `logs/`; the daemon reads the same name (`SHELL_ERRORS_FILE` in `shell-errors.ts`).
pub const SHELL_ERRORS_FILE: &str = "shell-errors.jsonl";
/// A bigger file is an error in a loop that no daemon took: the lines after it are dropped until the daemon takes the file.
const MAX_FILE_BYTES: u64 = 1024 * 1024;

static FILE: OnceLock<PathBuf> = OnceLock::new();

/// Sets where errors go and installs the panic hook; called once, when the state directory is known.
pub fn init(home: &Path) {
    if FILE.set(home.join("logs").join(SHELL_ERRORS_FILE)).is_err() {
        return;
    }
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let location = info.location().map(|l| format!("{}:{}", l.file(), l.line()));
        let area = location.as_deref().map(area_of_file).unwrap_or("panic").to_string();
        record(&area, "panic", &panic_message(info.payload()), location.as_deref());
        default_hook(info);
    }));
}

/// An error of the shell: written to stderr as before and into the journal file. `module` is the caller's
/// `module_path!()`, `location` its `file!():line!()`.
pub fn report(module: &str, location: &str, message: &str) {
    eprintln!("[desktop] {message}");
    let area = module.rsplit("::").next().unwrap_or(module);
    record(area, "error", message, Some(location));
}

/// `report_error!("changing the tray icon: {err}")`: `report` with the caller's module and line.
#[macro_export]
macro_rules! report_error {
    ($($arg:tt)*) => {
        $crate::error_journal::report(module_path!(), concat!(file!(), ":", line!()), &format!($($arg)*))
    };
}

fn record(area: &str, kind: &str, message: &str, location: Option<&str>) {
    let Some(file) = FILE.get() else { return };
    let _ = append(file, &error_line(now_ms(), area, kind, message, location));
}

fn append(file: &Path, line: &str) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    if std::fs::metadata(file).is_ok_and(|m| m.len() > MAX_FILE_BYTES) {
        return Ok(());
    }
    let mut out = OpenOptions::new().create(true).append(true).open(file)?;
    out.write_all(line.as_bytes())
}

/// One line of the file, as the daemon's `ShellErrorLine` reads it.
fn error_line(at_ms: u128, area: &str, kind: &str, message: &str, location: Option<&str>) -> String {
    let value = serde_json::json!({ "atMs": at_ms, "area": area, "kind": kind, "message": message, "location": location });
    format!("{value}\n")
}

/// `src/badge.rs:12` gives `badge`; a file outside the shell's sources (a library's panic) gives `panic`.
fn area_of_file(location: &str) -> &str {
    let file = location.split(':').next().unwrap_or(location);
    match file.strip_prefix("src/").or_else(|| file.strip_prefix("src\\")) {
        Some(name) => name.strip_suffix(".rs").unwrap_or(name),
        None => "panic",
    }
}

fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| (*s).to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "a panic without a message".to_string())
}

fn now_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_has_the_fields_the_daemon_reads() {
        let line = error_line(1_700_000_000_000, "badge", "error", "changing the tray icon: \"boom\"", Some("src/badge.rs:201"));
        assert!(line.ends_with('\n') && !line.trim_end().contains('\n'));
        let value: serde_json::Value = serde_json::from_str(&line).expect("JSON");
        assert_eq!(
            value,
            serde_json::json!({
                "atMs": 1_700_000_000_000u64,
                "area": "badge",
                "kind": "error",
                "message": "changing the tray icon: \"boom\"",
                "location": "src/badge.rs:201"
            })
        );
        let without_location: serde_json::Value = serde_json::from_str(&error_line(1, "panic", "panic", "x", None)).expect("JSON");
        assert_eq!(without_location["location"], serde_json::Value::Null);
    }

    #[test]
    fn the_area_of_a_panic_is_its_shell_file() {
        assert_eq!(area_of_file("src/badge.rs:12"), "badge");
        assert_eq!(area_of_file("src\\windows.rs:3"), "windows");
        assert_eq!(area_of_file("/home/u/.cargo/registry/src/tauri-2.0.0/src/app.rs:10"), "panic");
    }

    #[test]
    fn appended_lines_stay_and_a_full_file_takes_no_more() {
        let dir = std::env::temp_dir().join(format!("trackwall-shell-errors-{}", std::process::id()));
        let file = dir.join("logs").join(SHELL_ERRORS_FILE);
        let _ = std::fs::remove_dir_all(&dir);
        append(&file, "a\n").expect("first line");
        append(&file, "b\n").expect("second line");
        assert_eq!(std::fs::read_to_string(&file).expect("file"), "a\nb\n");
        std::fs::write(&file, "x".repeat(MAX_FILE_BYTES as usize + 1)).expect("full file");
        append(&file, "c\n").expect("dropped line");
        assert!(!std::fs::read_to_string(&file).expect("file").ends_with("c\n"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_panic_message_is_read_from_both_kinds_of_payload() {
        assert_eq!(panic_message(&"static text"), "static text");
        assert_eq!(panic_message(&String::from("owned text")), "owned text");
        assert_eq!(panic_message(&42), "a panic without a message");
    }
}
