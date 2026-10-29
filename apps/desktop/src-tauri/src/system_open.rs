//! Opens a web page in the default browser, or a folder of the daemon's container in VS Code, from the window itself:
//! a remote daemon has no desktop and cannot open them (ADR-120, ADR-130), and a WebView opens no new tabs. The same
//! commands as the daemon's `infra/system-open.ts`. It also reveals a folder in Explorer or Finder (ADR-131).

use std::path::Path;
use std::process::{Command, Stdio};
use tauri::Url;

/// What a window may hand to the system: a web page (`WebAddress` in protocol) or VS Code attached to a container
/// (`containerEditorUrl` in protocol). Never `file:` or another app's protocol, which could run a program.
fn openable(url: &str) -> Option<Url> {
    let url = Url::parse(url).ok()?;
    let allowed = match url.scheme() {
        "http" | "https" => url.has_host(),
        "vscode" => url.host_str() == Some("vscode-remote") && url.path().starts_with("/attached-container+"),
        _ => false,
    };
    allowed.then_some(url)
}

/// Hands the address to the system without waiting for what opens it.
#[tauri::command]
pub fn open_outside(url: String) -> Result<(), String> {
    // The parsed form is percent-encoded, so no space or quote of the original reaches the command line.
    let url = openable(&url).ok_or_else(|| format!("not an address the app opens: {}", url.chars().take(80).collect::<String>()))?;
    let mut cmd = command(url.as_str());
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    cmd.spawn().map(drop).map_err(|e| format!("could not open the address: {e}"))
}

/// Shows `folder` selected in its parent folder in Explorer or Finder. Revealing, not opening: should the path turn into
/// a file between the caller's check and the file manager (a volume a container writes to), a file is only selected,
/// never opened or run. Linux has no such command, so there it is refused.
pub fn reveal_folder(folder: &Path) -> Result<(), String> {
    let mut cmd = reveal_command(folder)?;
    cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    cmd.spawn().map(drop).map_err(|e| format!("could not show the folder: {e}"))
}

/// `/select,` with the path in quotes, as it is: Explorer splits its command line at commas (the daemon's
/// `folderCommand`), and the path is built from parts that hold no quote.
#[cfg(windows)]
fn reveal_command(folder: &Path) -> Result<Command, String> {
    use std::ffi::OsString;
    use std::os::windows::process::CommandExt;
    let mut arg = OsString::from("/select,\"");
    arg.push(folder.as_os_str());
    arg.push("\"");
    let mut cmd = Command::new("explorer.exe");
    cmd.raw_arg(arg);
    Ok(cmd)
}

#[cfg(target_os = "macos")]
fn reveal_command(folder: &Path) -> Result<Command, String> {
    let mut cmd = Command::new("open");
    cmd.arg("-R").arg(folder);
    Ok(cmd)
}

#[cfg(not(any(windows, target_os = "macos")))]
fn reveal_command(_folder: &Path) -> Result<Command, String> {
    Err("showing a folder of the container is not supported on Linux".into())
}

#[cfg(windows)]
fn command(url: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = Command::new("rundll32");
    cmd.arg("url.dll,FileProtocolHandler").arg(url).creation_flags(CREATE_NO_WINDOW);
    cmd
}

#[cfg(not(windows))]
fn command(url: &str) -> Command {
    let mut cmd = Command::new(if cfg!(target_os = "macos") { "open" } else { "xdg-open" });
    cmd.arg(url);
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn opens_web_pages_and_vs_code_attached_to_a_container() {
        assert!(openable("https://gitlab.example.com/group/repo/-/merge_requests/new?x=1").is_some());
        assert!(openable("http://127.0.0.1:41000/").is_some());
        assert!(openable("vscode://vscode-remote/attached-container+7b22/workspaces/repo").is_some());
    }

    #[test]
    fn opens_nothing_that_could_run_a_program() {
        for url in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "ms-msdt:/id",
            "vscode://file/C:/repo",
            "vscode://ms-vscode.some-extension/run",
            "mailto:someone@example.com",
            "not a url",
        ] {
            assert!(openable(url).is_none(), "{url}");
        }
    }

    #[test]
    fn hands_the_system_the_encoded_form() {
        let url = openable("https://example.com/a b\"c").unwrap();
        assert_eq!(url.as_str(), "https://example.com/a%20b%22c");
    }
}
