//! Translucent window background (ADR-11): Mica on Windows 11, Acrylic on Windows 10, vibrancy on macOS.
//!
//! The window is transparent (`transparent` in `tauri.conf.json`), so without an effect the desktop would show through it.
//! The UI paints an opaque background by default and removes it only once the shell sets an attribute on `<html>`
//! with the name of the effect the system actually accepted. The window starts hidden (`visible: false`) and shows
//! only after the script setting the attribute has run, so that no opaque background flashes at startup.
//! A page reload (F5) paints it opaque until loading ends; this is deliberately left (ADR-11).
//! Tauri's `set_effects` does not fit here, because it takes only the first effect of the list and does not say whether it worked.

use crate::lock::lock;
use crate::windows;
use std::collections::HashMap;
use std::fmt::Display;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Manager, Webview, WebviewWindow};

/// An effect the system accepted; `index.css` checks only that the attribute is present, the name is for diagnostics.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowEffect {
    #[cfg_attr(not(windows), allow(dead_code))]
    Mica,
    #[cfg_attr(not(windows), allow(dead_code))]
    Acrylic,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Vibrancy,
}

impl WindowEffect {
    fn as_str(self) -> &'static str {
        match self {
            WindowEffect::Mica => "mica",
            WindowEffect::Acrylic => "acrylic",
            WindowEffect::Vibrancy => "vibrancy",
        }
    }
}

/// The attribute on `<html>` that makes `packages/ui/src/index.css` switch the background to translucent.
const ATTRIBUTE: &str = "data-window-effect";

type Apply<W, E> = fn(&W) -> Result<(), E>;

#[cfg(any(windows, target_os = "macos"))]
type ApplyError = window_vibrancy::Error;
#[cfg(not(any(windows, target_os = "macos")))]
type ApplyError = String;

/// The `--background` colour from `packages/ui/src/index.css` at about 70% opacity: Acrylic itself is light,
/// and without darkening, text on it is hard to read.
#[cfg(windows)]
const ACRYLIC_TINT: (u8, u8, u8, u8) = (9, 9, 11, 180);

/// Effects in the order they are tried. Mica has no performance problems but needs Windows 11. Acrylic works
/// from Windows 10 1809, but it can stutter while dragging the window on Windows 10 1903+
/// (window-vibrancy documentation). Empty outside Windows and macOS: there the compositor decides on transparency.
fn candidates() -> &'static [(WindowEffect, Apply<WebviewWindow, ApplyError>)] {
    #[cfg(windows)]
    return &[
        (WindowEffect::Mica, |w| window_vibrancy::apply_mica(w, Some(true))),
        (WindowEffect::Acrylic, |w| window_vibrancy::apply_acrylic(w, Some(ACRYLIC_TINT))),
    ];
    #[cfg(target_os = "macos")]
    return &[(WindowEffect::Vibrancy, |w| {
        use window_vibrancy::{NSVisualEffectMaterial, NSVisualEffectState};
        window_vibrancy::apply_vibrancy(
            w,
            NSVisualEffectMaterial::UnderWindowBackground,
            Some(NSVisualEffectState::FollowsWindowActiveState),
            None,
        )
    })];
    #[cfg(not(any(windows, target_os = "macos")))]
    return &[];
}

/// Tries the effects in turn and returns the first one accepted, or `None` when none is. Rejection reasons go to stderr,
/// visible only in `tauri dev` (the release on Windows has no console).
fn first_applied<W, E: Display>(window: &W, candidates: &[(WindowEffect, Apply<W, E>)]) -> Option<WindowEffect> {
    for (effect, apply) in candidates {
        match apply(window) {
            Ok(()) => return Some(*effect),
            Err(err) => eprintln!("[desktop] window effect {effect:?} unavailable: {err}"),
        }
    }
    None
}

/// Should the page never report the end of loading (WKWebView does not report it on a navigation error),
/// the window shows after this time anyway, with an opaque UI.
const REVEAL_FALLBACK: Duration = Duration::from_secs(10);

/// The effect a window accepted (unset until it is applied on the main thread) and whether the window has been shown
/// already (by its page, the tray or a second launch).
pub struct AppliedEffect {
    effect: OnceLock<Option<WindowEffect>>,
    revealed: AtomicBool,
}

impl AppliedEffect {
    fn new() -> Self {
        AppliedEffect { effect: OnceLock::new(), revealed: AtomicBool::new(false) }
    }

    fn mark_revealed(&self) {
        self.revealed.store(true, Ordering::SeqCst);
    }

    fn is_revealed(&self) -> bool {
        self.revealed.load(Ordering::SeqCst)
    }

    /// The only place that decides to show a window by itself: the check and the mark in one step, so the page, the
    /// fallback timer and the tray do not show it twice.
    fn reveal_once(&self, reveal: impl FnOnce()) {
        if !self.revealed.swap(true, Ordering::SeqCst) {
            reveal();
        }
    }
}

/// The effect of every open window by label (ADR-49: the main window and extra windows). An extra window's entry
/// exists before the window is built, so a reveal from the tray or its page always lands on it.
#[derive(Default)]
pub struct WindowEffects(Mutex<HashMap<String, Arc<AppliedEffect>>>);

impl WindowEffects {
    /// The window's entry, created when there is none yet.
    pub fn register(&self, label: &str) -> Arc<AppliedEffect> {
        let mut entries = lock(&self.0);
        Arc::clone(entries.entry(label.to_string()).or_insert_with(|| Arc::new(AppliedEffect::new())))
    }

    /// Applies the first effect the system accepts and starts the fallback timer. Must run on the main thread (AppKit
    /// on macOS). A page that has already loaded and shown its window opaque gets the effect now.
    pub fn apply(&self, window: &WebviewWindow) {
        let applied = self.register(window.label());
        let _ = applied.effect.set(first_applied(window, candidates()));
        if applied.is_revealed() {
            pass_to_ui(window.as_ref(), &applied);
        }
        reveal_fallback(window.app_handle(), window.label(), applied);
    }

    /// A window shown from the tray before its page has loaded does not pop up again after loading.
    pub fn mark_revealed(&self, label: &str) {
        if let Some(applied) = lock(&self.0).get(label) {
            applied.mark_revealed();
        }
    }

    pub fn forget(&self, label: &str) {
        lock(&self.0).remove(label);
    }

    /// Whether the window's page has yet to load and show it: showing it now would flash the opaque background.
    pub fn reveal_pending(&self, label: &str) -> bool {
        lock(&self.0).get(label).is_some_and(|applied| !applied.is_revealed())
    }
}

/// The script that passes the accepted effect to the UI.
fn ui_script(effect: WindowEffect) -> String {
    format!("document.documentElement.setAttribute({ATTRIBUTE:?}, {:?});", effect.as_str())
}

/// Sets the attribute of an applied effect on the page, without waiting for it.
fn pass_to_ui(webview: &Webview, applied: &AppliedEffect) {
    if let Some(Some(effect)) = applied.effect.get() {
        if let Err(err) = webview.eval(ui_script(*effect)) {
            eprintln!("[desktop] passing the window effect to the UI: {err}");
        }
    }
}

/// After every page load sets the attribute, and after the first one shows the window, but only once the script has
/// run (`eval` is asynchronous).
pub fn on_page_load(webview: &Webview, payload: &PageLoadPayload<'_>) {
    if payload.event() != PageLoadEvent::Finished {
        return;
    }
    let app = webview.app_handle().clone();
    let label = webview.label().to_string();
    let applied = app.state::<WindowEffects>().register(&label);
    let effect = applied.effect.get().copied();
    let Some(Some(effect)) = effect.filter(|_| !applied.is_revealed()) else {
        // Shown already (a reload, the tray), no effect on this system, or the effect is not applied yet: an extra
        // window's effect is applied on the main thread right after it is built, so a faster page shows its window
        // opaque and `apply` passes the effect to the UI when it comes.
        applied.reveal_once(|| windows::show(&app, &label));
        pass_to_ui(webview, &applied);
        return;
    };
    let (after, after_label, after_applied) = (app.clone(), label.clone(), Arc::clone(&applied));
    let shown = webview.eval_with_callback(ui_script(effect), move |_| after_applied.reveal_once(|| windows::show(&after, &after_label)));
    if let Err(err) = shown {
        eprintln!("[desktop] passing the window effect to the UI: {err}");
        applied.reveal_once(|| windows::show(&app, &label));
    }
}

/// Shows the window after `REVEAL_FALLBACK` if nothing has shown it before. The timer holds this window's entry, so
/// a later window with the same label is not shown by it.
fn reveal_fallback(app: &AppHandle, label: &str, applied: Arc<AppliedEffect>) {
    let (app, label) = (app.clone(), label.to_string());
    std::thread::spawn(move || {
        std::thread::sleep(REVEAL_FALLBACK);
        applied.reveal_once(|| windows::show(&app, &label));
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// The list of effects called, in the order tried.
    type Calls = RefCell<Vec<&'static str>>;

    #[test]
    fn falls_back_to_next_effect_and_stops_at_first_success() {
        let calls = RefCell::new(Vec::new());
        let candidates: &[(WindowEffect, Apply<Calls, String>)] = &[
            (WindowEffect::Mica, |c| {
                c.borrow_mut().push("mica");
                Err("Windows 10".into())
            }),
            (WindowEffect::Acrylic, |c| {
                c.borrow_mut().push("acrylic");
                Ok(())
            }),
            (WindowEffect::Vibrancy, |c| {
                c.borrow_mut().push("vibrancy");
                Ok(())
            }),
        ];
        assert_eq!(first_applied(&calls, candidates), Some(WindowEffect::Acrylic));
        assert_eq!(*calls.borrow(), ["mica", "acrylic"]);
    }

    #[test]
    fn none_when_every_effect_is_rejected() {
        let rejected: &[(WindowEffect, Apply<(), String>)] =
            &[(WindowEffect::Mica, |_| Err("unavailable".into())), (WindowEffect::Acrylic, |_| Err("unavailable".into()))];
        assert_eq!(first_applied(&(), rejected), None);
        assert_eq!(first_applied::<(), String>(&(), &[]), None);
    }

    #[test]
    fn window_is_revealed_once_even_when_shown_from_tray_first() {
        let shown = std::cell::Cell::new(0);
        let count = || shown.set(shown.get() + 1);
        let applied = AppliedEffect::new();
        applied.reveal_once(count);
        applied.reveal_once(count);
        assert_eq!(shown.get(), 1);

        let from_tray = AppliedEffect::new();
        from_tray.mark_revealed();
        from_tray.reveal_once(count);
        assert_eq!(shown.get(), 1);
    }

    #[test]
    fn ui_script_sets_attribute_with_effect_name() {
        assert_eq!(ui_script(WindowEffect::Mica), "document.documentElement.setAttribute(\"data-window-effect\", \"mica\");");
    }

    fn order() -> Vec<WindowEffect> {
        candidates().iter().map(|(effect, _)| *effect).collect()
    }

    #[cfg(windows)]
    #[test]
    fn windows_tries_mica_before_acrylic() {
        assert_eq!(order(), [WindowEffect::Mica, WindowEffect::Acrylic]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_uses_vibrancy() {
        assert_eq!(order(), [WindowEffect::Vibrancy]);
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    #[test]
    fn other_systems_have_no_effect() {
        assert!(order().is_empty());
    }
}
