//! Keeping the screen on (ADR-218): an opt-in setting that keeps the display from turning off, and so the screen saver
//! and the lock that follow it, while agents work or while the app runs. The app asks the system the way a video player
//! or a presentation does: a display power request on Windows (`PowerSetRequest`, listed by `powercfg /requests`) and a
//! `PreventUserIdleDisplaySleep` assertion on macOS (listed by `pmset -g assertions`). Nothing simulates input, so a
//! lock an administrator enforces after a time without input (a Windows policy) can still lock the screen.
//!
//! The setting is the shell's own, in `keep-screen-on.json`, and only Settings changes it (§8: no MCP tool changes it).
//! Whether agents work comes from the session list the tray polls (`attention.rs`). The request ends when it is not
//! wanted any more, when the app quits, and with the process in any case, so a crash leaves nothing behind.

use crate::json_file;
use crate::lock::lock;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

/// File name in the shell's configuration directory.
const FILE: &str = "keep-screen-on.json";
/// What the system lists as the reason for the request.
const REASON: &str = "Trackwall keeps the screen on while agents work";

/// The choice in Settings (`KeepScreenOn` in the UI's `keep-screen-on.ts`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum KeepScreenOn {
    /// The system's own power settings decide, as without Trackwall.
    #[default]
    Off,
    /// Only while at least one agent is in the middle of a turn.
    WhileAgentsWork,
    /// As long as the app runs.
    Always,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Saved {
    keep_screen_on: KeepScreenOn,
}

/// The setting from the file's text; a missing or damaged file, or a value this shell does not know, is `Off`, so the
/// screen never stays on without the user having chosen it.
fn parse(text: &str) -> KeepScreenOn {
    serde_json::from_str::<Saved>(text).map(|saved| saved.keep_screen_on).unwrap_or_default()
}

/// Whether the screen should be kept on now.
fn wanted(setting: KeepScreenOn, agents_working: bool) -> bool {
    match setting {
        KeepScreenOn::Off => false,
        KeepScreenOn::WhileAgentsWork => agents_working,
        KeepScreenOn::Always => true,
    }
}

#[derive(Default)]
struct Inner {
    setting: KeepScreenOn,
    agents_working: bool,
    /// What the last change asked for; a request the system refused is not asked again until this changes, so a poll
    /// every few seconds does not fill the error journal.
    asked: bool,
    held: Option<system::DisplayRequest>,
}

impl Inner {
    fn apply(&mut self) {
        let now = wanted(self.setting, self.agents_working);
        if now == self.asked {
            return;
        }
        self.asked = now;
        if !now {
            self.held = None;
            return;
        }
        match system::DisplayRequest::new(REASON) {
            Ok(request) => self.held = Some(request),
            Err(err) => crate::report_error!("keeping the screen on: {err}"),
        }
    }
}

/// The setting, whether agents work, and the request held for them. Managed from the start and loaded in `setup`.
#[derive(Default)]
pub struct ScreenOn {
    inner: Mutex<Inner>,
    file: OnceLock<PathBuf>,
}

impl ScreenOn {
    /// Reads the saved setting; with `Always` the screen stays on from the start.
    pub fn load(app: &AppHandle) {
        let Some(path) = json_file::config_file(app, FILE) else { return };
        let screen_on = app.state::<ScreenOn>();
        let mut inner = lock(&screen_on.inner);
        inner.setting = json_file::load(&path, parse);
        inner.apply();
        let _ = screen_on.file.set(path);
    }

    /// Called after every poll of the session list; `false` also when the daemon is gone.
    pub fn agents_working(app: &AppHandle, working: bool) {
        let screen_on = app.state::<ScreenOn>();
        let mut inner = lock(&screen_on.inner);
        inner.agents_working = working;
        inner.apply();
    }

    /// Ends the request before the app quits, rather than leaving it to the end of the process.
    pub fn release(app: &AppHandle) {
        let screen_on = app.state::<ScreenOn>();
        let mut inner = lock(&screen_on.inner);
        inner.setting = KeepScreenOn::Off;
        inner.apply();
    }
}

/// The setting as saved.
#[tauri::command]
pub fn keep_screen_on(app: AppHandle) -> KeepScreenOn {
    lock(&app.state::<ScreenOn>().inner).setting
}

/// Saves the setting, applies it at once and answers what is saved now.
#[tauri::command]
pub fn set_keep_screen_on(app: AppHandle, setting: KeepScreenOn) -> Result<KeepScreenOn, String> {
    let screen_on = app.state::<ScreenOn>();
    let path = screen_on.file.get().ok_or("the system gives the app no configuration directory to save the setting in")?;
    let mut inner = lock(&screen_on.inner);
    json_file::save(path, &Saved { keep_screen_on: setting }).map_err(|e| format!("saving the setting: {e}"))?;
    inner.setting = setting;
    inner.apply();
    Ok(inner.setting)
}

#[cfg(windows)]
mod system {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Power::{
        PowerClearRequest, PowerCreateRequest, PowerRequestDisplayRequired, PowerRequestSystemRequired, PowerSetRequest,
    };
    use windows_sys::Win32::System::SystemServices::POWER_REQUEST_CONTEXT_VERSION;
    use windows_sys::Win32::System::Threading::{POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0};

    /// A power request that keeps the display, and with it the computer, on; cleared and closed on drop. Unlike
    /// `SetThreadExecutionState` it belongs to no thread, so any thread can take and end it.
    pub struct DisplayRequest(HANDLE);

    // The handle is a kernel object, usable from any thread.
    unsafe impl Send for DisplayRequest {}

    impl DisplayRequest {
        pub fn new(reason: &str) -> Result<Self, String> {
            let mut wide: Vec<u16> = reason.encode_utf16().chain(std::iter::once(0)).collect();
            let context = REASON_CONTEXT {
                Version: POWER_REQUEST_CONTEXT_VERSION,
                Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
                Reason: REASON_CONTEXT_0 { SimpleReasonString: wide.as_mut_ptr() },
            };
            // SAFETY: `context` and the string it points at live until the call returns; the system copies the reason.
            let handle = unsafe { PowerCreateRequest(&context) };
            if handle.is_null() || handle == INVALID_HANDLE_VALUE {
                return Err(format!("the system refused a power request: {}", std::io::Error::last_os_error()));
            }
            let request = DisplayRequest(handle);
            for kind in [PowerRequestDisplayRequired, PowerRequestSystemRequired] {
                // SAFETY: `handle` is the open request created above.
                if unsafe { PowerSetRequest(handle, kind) } == 0 {
                    return Err(format!("the system refused to keep the screen on: {}", std::io::Error::last_os_error()));
                }
            }
            Ok(request)
        }
    }

    impl Drop for DisplayRequest {
        fn drop(&mut self) {
            // SAFETY: the handle is open until here; clearing a type that was never set fails harmlessly.
            unsafe {
                PowerClearRequest(self.0, PowerRequestDisplayRequired);
                PowerClearRequest(self.0, PowerRequestSystemRequired);
                CloseHandle(self.0);
            }
        }
    }
}

#[cfg(target_os = "macos")]
mod system {
    use std::ffi::{c_char, c_void, CString};

    type CFStringRef = *const c_void;
    const UTF8: u32 = 0x0800_0100; // kCFStringEncodingUTF8
    const LEVEL_ON: u32 = 255; // kIOPMAssertionLevelOn
    const SUCCESS: i32 = 0; // kIOReturnSuccess
    /// kIOPMAssertionTypePreventUserIdleDisplaySleep: the display, and so the computer, stays awake.
    const PREVENT_DISPLAY_SLEEP: &str = "PreventUserIdleDisplaySleep";

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(alloc: *const c_void, text: *const c_char, encoding: u32) -> CFStringRef;
        fn CFRelease(cf: *const c_void);
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(kind: CFStringRef, level: u32, name: CFStringRef, id: *mut u32) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
    }

    /// A power assertion that keeps the display on; released on drop.
    pub struct DisplayRequest(u32);

    fn cf_string(text: &str) -> Result<CFStringRef, String> {
        let text = CString::new(text).map_err(|e| e.to_string())?;
        // SAFETY: a valid NUL-terminated string; the result is released by the caller.
        let string = unsafe { CFStringCreateWithCString(std::ptr::null(), text.as_ptr(), UTF8) };
        if string.is_null() {
            return Err("could not make a system string".into());
        }
        Ok(string)
    }

    impl DisplayRequest {
        pub fn new(reason: &str) -> Result<Self, String> {
            let kind = cf_string(PREVENT_DISPLAY_SLEEP)?;
            let name = match cf_string(reason) {
                Ok(name) => name,
                Err(err) => {
                    // SAFETY: created above and not used after this.
                    unsafe { CFRelease(kind) };
                    return Err(err);
                }
            };
            let mut id = 0;
            // SAFETY: both strings are valid until released below; the call copies what it keeps.
            let result = unsafe { IOPMAssertionCreateWithName(kind, LEVEL_ON, name, &mut id) };
            // SAFETY: both were created above and are not used after this.
            unsafe {
                CFRelease(name);
                CFRelease(kind);
            }
            if result != SUCCESS {
                return Err(format!("the system refused a power assertion (IOReturn {result:#x})"));
            }
            Ok(DisplayRequest(id))
        }
    }

    impl Drop for DisplayRequest {
        fn drop(&mut self) {
            // SAFETY: the assertion was created by this value and is released once.
            unsafe { IOPMAssertionRelease(self.0) };
        }
    }
}

/// The shell is built for Windows and macOS; elsewhere (Linux, where its tests run) there is nothing to ask.
#[cfg(not(any(windows, target_os = "macos")))]
mod system {
    pub struct DisplayRequest;

    impl DisplayRequest {
        pub fn new(_reason: &str) -> Result<Self, String> {
            Err("keeping the screen on works only on Windows and macOS".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_damaged_or_unknown_setting_is_off() {
        assert_eq!(parse(""), KeepScreenOn::Off);
        assert_eq!(parse("{not json"), KeepScreenOn::Off);
        assert_eq!(parse(r#"{"keepScreenOn":"forever"}"#), KeepScreenOn::Off);
    }

    #[test]
    fn a_saved_setting_reads_back_as_saved() {
        for setting in [KeepScreenOn::Off, KeepScreenOn::WhileAgentsWork, KeepScreenOn::Always] {
            let text = serde_json::to_string(&Saved { keep_screen_on: setting }).expect("serialize");
            assert_eq!(parse(&text), setting);
        }
        assert_eq!(parse(r#"{"keepScreenOn":"while-agents-work"}"#), KeepScreenOn::WhileAgentsWork);
    }

    #[test]
    fn the_screen_stays_on_only_when_the_setting_asks_for_it() {
        assert!(!wanted(KeepScreenOn::Off, false));
        assert!(!wanted(KeepScreenOn::Off, true));
        assert!(!wanted(KeepScreenOn::WhileAgentsWork, false));
        assert!(wanted(KeepScreenOn::WhileAgentsWork, true));
        assert!(wanted(KeepScreenOn::Always, false));
        assert!(wanted(KeepScreenOn::Always, true));
    }

    #[test]
    fn the_system_is_asked_once_per_change_not_on_every_poll() {
        let mut inner = Inner { setting: KeepScreenOn::WhileAgentsWork, ..Inner::default() };
        inner.agents_working = true;
        inner.apply();
        assert!(inner.asked);
        inner.apply();
        assert!(inner.asked);
        inner.agents_working = false;
        inner.apply();
        assert!(!inner.asked);
        assert!(inner.held.is_none());
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn the_system_grants_the_request_and_it_ends_when_dropped() {
        let request = system::DisplayRequest::new(REASON).expect("the system takes the request");
        drop(request);
    }

    #[cfg(any(windows, target_os = "macos"))]
    #[test]
    fn agents_starting_and_finishing_take_and_end_the_request() {
        let mut inner = Inner { setting: KeepScreenOn::WhileAgentsWork, ..Inner::default() };
        inner.agents_working = true;
        inner.apply();
        assert!(inner.held.is_some());
        inner.agents_working = false;
        inner.apply();
        assert!(inner.held.is_none());
    }
}
