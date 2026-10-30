//! Opens a web page in the default browser, or a folder of the daemon's container in VS Code, from the window itself:
//! a remote daemon has no desktop and cannot open them (ADR-120, ADR-130), and a WebView opens no new tabs. The same
//! commands as the daemon's `infra/system-open.ts`. It also reveals a folder in Explorer or Finder (ADR-131).

use std::path::Path;
use std::process::{Command, Stdio};
use tauri::Url;

/// What a window may hand to the system: a web page (`WebAddress` in protocol) or VS Code in a container, attached to it
/// or through its dev container's configuration (`containerEditorUrl` and `devContainerEditorUrl` in protocol). Never
/// `file:` or another app's protocol, which could run a program.
fn openable(url: &str) -> Option<Url> {
    let url = Url::parse(url).ok()?;
    let allowed = match url.scheme() {
        "http" | "https" => url.has_host(),
        "vscode" => url.host_str() == Some("vscode-remote") && url.as_str().len() <= MAX_VSCODE_URL_LEN && vscode_remote(url.path()),
        _ => false,
    };
    allowed.then_some(url)
}

/// Longer addresses are cut or dropped by the system's URL handler on Windows (2083 characters), and the click would
/// silently do nothing.
const MAX_VSCODE_URL_LEN: usize = 2048;

/// A container to attach to, or a dev container opened from a folder of this computer. A `dev-container+` address opens
/// that folder's `devcontainer.json`, whose `initializeCommand` runs on this computer, so the folder is decoded and must
/// be a plain local path: not the extension's JSON form, which can name any config file, and not a network path, which
/// reaches the volumes a container writes to (ADR-121, §8).
fn vscode_remote(path: &str) -> bool {
    if path.starts_with("/attached-container+") {
        return true;
    }
    let Some(hex) = path.strip_prefix("/dev-container+").and_then(|rest| rest.split('/').next()) else {
        return false;
    };
    decode_hex(hex).is_some_and(|folder| is_local_folder(&folder))
}

fn decode_hex(hex: &str) -> Option<String> {
    if hex.is_empty() || !hex.len().is_multiple_of(2) {
        return None;
    }
    let bytes = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok()).collect::<Option<Vec<u8>>>()?;
    String::from_utf8(bytes).ok()
}

/// `C:\…` or `/…`, never `\\server\…`, `//server/…` or `\\?\…`.
pub fn is_local_folder(folder: &str) -> bool {
    let bytes = folder.as_bytes();
    let drive = bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'\\' | b'/');
    let unix = folder.starts_with('/') && !folder.starts_with("//");
    drive || unix
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
    fn opens_web_pages_and_vs_code_in_a_container() {
        assert!(openable("https://gitlab.example.com/group/repo/-/merge_requests/new?x=1").is_some());
        assert!(openable("http://127.0.0.1:41000/").is_some());
        assert!(openable("vscode://vscode-remote/attached-container+7b22/workspaces/repo").is_some());
        assert!(openable(&dev_container(r"C:\Users\me\Dev\work space")).is_some());
        assert!(openable(&dev_container("/Users/zoë/Dev")).is_some());
    }

    #[test]
    fn opens_nothing_that_could_run_a_program() {
        for url in [
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "ms-msdt:/id",
            "vscode://file/C:/repo",
            "vscode://ms-vscode.some-extension/run",
            "vscode://vscode-remote/ssh-remote+host/repo",
            "mailto:someone@example.com",
            "not a url",
        ] {
            assert!(openable(url).is_none(), "{url}");
        }
    }

    fn dev_container(folder: &str) -> String {
        let hex: String = folder.bytes().map(|b| format!("{b:02x}")).collect();
        format!("vscode://vscode-remote/dev-container+{hex}/workspaces/repo")
    }

    #[test]
    fn opens_a_dev_container_only_from_a_local_folder() {
        for folder in [
            r"\\wsl.localhost\rancher-desktop\var\lib\docker\volumes\repos\_data\shop",
            r"\\?\C:\Dev",
            "//server/share",
            r#"{"hostPath":"C:\\Dev","configFile":{"$mid":1,"path":"/c:/x/devcontainer.json","scheme":"file"}}"#,
            "Dev",
        ] {
            assert!(openable(&dev_container(folder)).is_none(), "{folder}");
        }
        assert!(openable("vscode://vscode-remote/dev-container+zz/workspaces/repo").is_none());
        assert!(openable("vscode://vscode-remote/dev-container+433/workspaces/repo").is_none());
        assert!(openable(&dev_container(&format!("C:\\{}", "a".repeat(1100)))).is_none());
    }

    #[test]
    fn hands_the_system_the_encoded_form() {
        let url = openable("https://example.com/a b\"c").unwrap();
        assert_eq!(url.as_str(), "https://example.com/a%20b%22c");
    }
}
