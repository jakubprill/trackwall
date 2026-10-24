//! Półprzezroczyste tło okna (ADR-11): Mica na Windows 11, Acrylic na Windows 10, vibrancy na macOS.
//!
//! Okno jest przezroczyste (`transparent` w `tauri.conf.json`), więc bez efektu byłoby widać przez nie pulpit.
//! UI domyślnie maluje nieprzezroczyste tło i zdejmuje je dopiero, gdy powłoka ustawi na `<html>` atrybut
//! z nazwą efektu, który system faktycznie przyjął. Okno startuje schowane (`visible: false`) i pokazuje się
//! dopiero, gdy skrypt ustawiający atrybut się wykonał, żeby przy starcie nie mignęło nieprzezroczyste tło.
//! Odświeżenie strony (F5) maluje ją nieprzezroczyście do końca ładowania; to świadomie zostawione (ADR-11).
//! `set_effects` z Tauri nie nadaje się tu, bo bierze tylko pierwszy efekt z listy i nie mówi, czy się udał.

use std::fmt::Display;
use std::sync::atomic::{AtomicBool, Ordering};
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

/// Efekt przyjęty w `setup` i to, czy okno zostało już pokazane (przez stronę, tray albo drugie uruchomienie).
pub struct AppliedEffect {
    effect: Option<WindowEffect>,
    revealed: AtomicBool,
}

impl AppliedEffect {
    pub fn mark_revealed(&self) {
        self.revealed.store(true, Ordering::SeqCst);
    }

    fn is_revealed(&self) -> bool {
        self.revealed.load(Ordering::SeqCst)
    }

    /// Jedyne miejsce, które decyduje o automatycznym pokazaniu okna: sprawdzenie i zaznaczenie naraz,
    /// więc strona, zapasowy timer i tray nie pokażą go dwa razy.
    fn reveal_once<A>(&self, app: &A, reveal: fn(&A)) {
        if !self.revealed.swap(true, Ordering::SeqCst) {
            reveal(app);
        }
    }
}

/// Musi działać na wątku głównym (wymóg AppKit na macOS), czyli w `setup`.
pub fn apply(window: &WebviewWindow) -> AppliedEffect {
    AppliedEffect { effect: first_applied(window, candidates()), revealed: AtomicBool::new(false) }
}

/// Skrypt, który przekazuje UI przyjęty efekt.
fn ui_script(effect: WindowEffect) -> String {
    format!("document.documentElement.setAttribute({ATTRIBUTE:?}, {:?});", effect.as_str())
}

/// Po każdym załadowaniu strony ustawia atrybut, a przy pierwszym pokazuje okno, ale dopiero gdy skrypt
/// się wykonał (`eval` jest asynchroniczny). `reveal` to `show_main` z `main.rs`.
pub fn on_page_load(webview: &Webview, payload: &PageLoadPayload<'_>, reveal: fn(&AppHandle)) {
    if payload.event() != PageLoadEvent::Finished {
        return;
    }
    let app = webview.app_handle().clone();
    // `setup` z `manage` kończy się przed obsługą zdarzeń strony; gdyby jednak nie, okno pokazuje się nieprzezroczyste.
    let Some(applied) = webview.try_state::<AppliedEffect>() else {
        reveal(&app);
        return;
    };
    let Some(effect) = applied.effect else {
        applied.reveal_once(&app, reveal);
        return;
    };
    let result = if applied.is_revealed() {
        webview.eval(ui_script(effect))
    } else {
        let after = app.clone();
        webview.eval_with_callback(ui_script(effect), move |_| after.state::<AppliedEffect>().reveal_once(&after, reveal))
    };
    if let Err(err) = result {
        eprintln!("[desktop] passing the window effect to the UI: {err}");
        applied.reveal_once(&app, reveal);
    }
}

/// Pokazuje okno po `REVEAL_FALLBACK`, jeśli nic go wcześniej nie pokazało.
pub fn reveal_fallback(app: &AppHandle, reveal: fn(&AppHandle)) {
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(REVEAL_FALLBACK);
        app.state::<AppliedEffect>().reveal_once(&app, reveal);
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
        let count: fn(&std::cell::Cell<u32>) = |c| c.set(c.get() + 1);
        let applied = AppliedEffect { effect: Some(WindowEffect::Mica), revealed: AtomicBool::new(false) };
        applied.reveal_once(&shown, count);
        applied.reveal_once(&shown, count);
        assert_eq!(shown.get(), 1);

        let from_tray = AppliedEffect { effect: Some(WindowEffect::Mica), revealed: AtomicBool::new(false) };
        from_tray.mark_revealed();
        from_tray.reveal_once(&shown, count);
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
