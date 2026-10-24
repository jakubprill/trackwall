//! Półprzezroczyste tło okna (ADR-11): Mica na Windows 11, Acrylic na Windows 10, vibrancy na macOS.
//!
//! Okno jest przezroczyste (`transparent` w `tauri.conf.json`), więc bez efektu byłoby widać przez nie pulpit.
//! UI domyślnie maluje nieprzezroczyste tło i zdejmuje je dopiero, gdy powłoka ustawi na `<html>` atrybut
//! z nazwą efektu, który system faktycznie przyjął. Okno startuje schowane (`visible: false`) i pokazuje się
//! dopiero, gdy skrypt ustawiający atrybut się wykonał, żeby przy starcie nie mignęło nieprzezroczyste tło.
//! Odświeżenie strony (F5) maluje ją nieprzezroczyście do końca ładowania; to świadomie zostawione (ADR-11).
//! `set_effects` z Tauri nie nadaje się tu, bo bierze tylko pierwszy efekt z listy i nie mówi, czy się udał.

use std::collections::HashMap;
use std::fmt::Display;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{AppHandle, Manager, Webview, WebviewWindow};

/// Efekt przyjęty przez system; `index.css` sprawdza tylko obecność atrybutu, nazwa służy diagnostyce.
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

/// Atrybut na `<html>`, od którego `packages/ui/src/index.css` przełącza tło na półprzezroczyste.
const ATTRIBUTE: &str = "data-window-effect";

type Apply<W, E> = fn(&W) -> Result<(), E>;

#[cfg(any(windows, target_os = "macos"))]
type ApplyError = window_vibrancy::Error;
#[cfg(not(any(windows, target_os = "macos")))]
type ApplyError = String;

/// Kolor `--background` z `packages/ui/src/index.css` z kryciem ok. 70%: Acrylic sam w sobie jest jasny
/// i bez przyciemnienia tekst na nim słabo się czyta.
#[cfg(windows)]
const ACRYLIC_TINT: (u8, u8, u8, u8) = (9, 9, 11, 180);

/// Efekty w kolejności prób. Mica nie ma problemów z wydajnością, ale wymaga Windows 11. Acrylic działa
/// od Windows 10 1809, za to przy przeciąganiu okna na Windows 10 1903+ potrafi przycinać
/// (dokumentacja window-vibrancy). Poza Windows i macOS pusto: tam o przezroczystości decyduje kompozytor.
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

/// Próbuje efektów po kolei i zwraca pierwszy przyjęty albo `None`, gdy żaden. Powody odrzucenia idą na stderr, widoczny
/// tylko w `tauri dev` (wydanie na Windowsie nie ma konsoli).
fn first_applied<W, E: Display>(window: &W, candidates: &[(WindowEffect, Apply<W, E>)]) -> Option<WindowEffect> {
    for (effect, apply) in candidates {
        match apply(window) {
            Ok(()) => return Some(*effect),
            Err(err) => eprintln!("[desktop] window effect {effect:?} unavailable: {err}"),
        }
    }
    None
}

/// Gdyby strona nigdy nie zgłosiła końca ładowania (WKWebView nie zgłasza go przy błędzie nawigacji),
/// okno i tak pokaże się po tym czasie, z nieprzezroczystym UI.
const REVEAL_FALLBACK: Duration = Duration::from_secs(10);

/// The effect a window accepted and whether the window has been shown already (by its page, the tray or a second
/// launch).
pub struct AppliedEffect {
    effect: Option<WindowEffect>,
    revealed: AtomicBool,
}

impl AppliedEffect {
    fn mark_revealed(&self) {
        self.revealed.store(true, Ordering::SeqCst);
    }

    fn is_revealed(&self) -> bool {
        self.revealed.load(Ordering::SeqCst)
    }

    /// Jedyne miejsce, które decyduje o automatycznym pokazaniu okna: sprawdzenie i zaznaczenie naraz,
    /// więc strona, zapasowy timer i tray nie pokażą go dwa razy.
    fn reveal_once(&self, reveal: impl FnOnce()) {
        if !self.revealed.swap(true, Ordering::SeqCst) {
            reveal();
        }
    }
}

/// Shows the window with this label; `show_window` in `main.rs`.
pub type Reveal = fn(&AppHandle, &str);

/// The applied effect of every open window by label (ADR-49: the main window and extra windows).
#[derive(Default)]
pub struct WindowEffects(Mutex<HashMap<String, Arc<AppliedEffect>>>);

impl WindowEffects {
    fn windows(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<AppliedEffect>>> {
        // Every change is a single insert or remove, so a poisoned map is still consistent.
        self.0.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Musi działać na wątku głównym (wymóg AppKit na macOS).
    pub fn apply(&self, window: &WebviewWindow) {
        let applied = AppliedEffect { effect: first_applied(window, candidates()), revealed: AtomicBool::new(false) };
        self.windows().insert(window.label().to_string(), Arc::new(applied));
    }

    fn get(&self, label: &str) -> Option<Arc<AppliedEffect>> {
        self.windows().get(label).cloned()
    }

    /// A window shown from the tray before its page has loaded does not pop up again after loading.
    pub fn mark_revealed(&self, label: &str) {
        if let Some(applied) = self.get(label) {
            applied.mark_revealed();
        }
    }

    pub fn forget(&self, label: &str) {
        self.windows().remove(label);
    }
}

/// Skrypt, który przekazuje UI przyjęty efekt.
fn ui_script(effect: WindowEffect) -> String {
    format!("document.documentElement.setAttribute({ATTRIBUTE:?}, {:?});", effect.as_str())
}

/// Po każdym załadowaniu strony ustawia atrybut, a przy pierwszym pokazuje okno, ale dopiero gdy skrypt
/// się wykonał (`eval` jest asynchroniczny).
pub fn on_page_load(webview: &Webview, payload: &PageLoadPayload<'_>, reveal: Reveal) {
    if payload.event() != PageLoadEvent::Finished {
        return;
    }
    let app = webview.app_handle().clone();
    let label = webview.label().to_string();
    // The main window's effect is applied in `setup`, before page events; an extra window's right after it is built,
    // on the main thread. A page that finishes loading before that shows its window opaque.
    let Some(applied) = app.try_state::<WindowEffects>().and_then(|effects| effects.get(&label)) else {
        reveal(&app, &label);
        return;
    };
    let Some(effect) = applied.effect else {
        applied.reveal_once(|| reveal(&app, &label));
        return;
    };
    let result = if applied.is_revealed() {
        webview.eval(ui_script(effect))
    } else {
        let (after, after_label, after_applied) = (app.clone(), label.clone(), Arc::clone(&applied));
        webview.eval_with_callback(ui_script(effect), move |_| after_applied.reveal_once(|| reveal(&after, &after_label)))
    };
    if let Err(err) = result {
        eprintln!("[desktop] passing the window effect to the UI: {err}");
        applied.reveal_once(|| reveal(&app, &label));
    }
}

/// Pokazuje okno po `REVEAL_FALLBACK`, jeśli nic go wcześniej nie pokazało.
pub fn reveal_fallback(app: &AppHandle, label: &str, reveal: Reveal) {
    let (app, label) = (app.clone(), label.to_string());
    std::thread::spawn(move || {
        std::thread::sleep(REVEAL_FALLBACK);
        if let Some(applied) = app.state::<WindowEffects>().get(&label) {
            applied.reveal_once(|| reveal(&app, &label));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Lista wywołanych efektów w kolejności prób.
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
            &[(WindowEffect::Mica, |_| Err("brak".into())), (WindowEffect::Acrylic, |_| Err("brak".into()))];
        assert_eq!(first_applied(&(), rejected), None);
        assert_eq!(first_applied::<(), String>(&(), &[]), None);
    }

    #[test]
    fn window_is_revealed_once_even_when_shown_from_tray_first() {
        let shown = std::cell::Cell::new(0);
        let count = || shown.set(shown.get() + 1);
        let applied = AppliedEffect { effect: Some(WindowEffect::Mica), revealed: AtomicBool::new(false) };
        applied.reveal_once(count);
        applied.reveal_once(count);
        assert_eq!(shown.get(), 1);

        let from_tray = AppliedEffect { effect: Some(WindowEffect::Mica), revealed: AtomicBool::new(false) };
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
