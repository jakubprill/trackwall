//! Półprzezroczyste tło okna (ADR-11): Mica na Windows 11, Acrylic na Windows 10, vibrancy na macOS.
//!
//! Okno jest przezroczyste (`transparent` w `tauri.conf.json`), więc bez efektu byłoby widać przez nie pulpit.
//! UI domyślnie maluje nieprzezroczyste tło i zdejmuje je dopiero, gdy powłoka ustawi na `<html>` atrybut
//! z nazwą efektu, który system faktycznie przyjął. Okno startuje schowane (`visible: false`) i pokazuje się
//! po załadowaniu strony z już ustawionym atrybutem, żeby przy starcie nie mignęło nieprzezroczyste tło.
//! `set_effects` z Tauri nie nadaje się tu, bo bierze tylko pierwszy efekt z listy i nie mówi, czy się udał.

use serde::Serialize;
use std::fmt::Display;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::webview::{PageLoadEvent, PageLoadPayload};
use tauri::{Manager, Runtime, Webview, WebviewWindow};

/// Wartość atrybutu `data-window-effect`; `index.css` sprawdza tylko jego obecność, nazwa służy diagnostyce.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowEffect {
    #[cfg_attr(not(windows), allow(dead_code))]
    Mica,
    #[cfg_attr(not(windows), allow(dead_code))]
    Acrylic,
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    Vibrancy,
    None,
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
        window_vibrancy::apply_vibrancy(w, NSVisualEffectMaterial::UnderWindowBackground, Some(NSVisualEffectState::FollowsWindowActiveState), None)
    })];
    #[cfg(not(any(windows, target_os = "macos")))]
    return &[];
}

/// Próbuje efektów po kolei i zwraca pierwszy przyjęty. Powody odrzucenia idą na stderr, widoczny
/// tylko w `tauri dev` (wydanie na Windowsie nie ma konsoli).
fn first_applied<W, E: Display>(window: &W, candidates: &[(WindowEffect, Apply<W, E>)]) -> WindowEffect {
    for (effect, apply) in candidates {
        match apply(window) {
            Ok(()) => return *effect,
            Err(err) => eprintln!("[desktop] efekt okna {effect:?} niedostępny: {err}"),
        }
    }
    WindowEffect::None
}

/// Efekt przyjęty w `setup` i to, czy okno zostało już raz pokazane po starcie.
pub struct AppliedEffect {
    effect: WindowEffect,
    revealed: AtomicBool,
}

/// Musi działać na wątku głównym (wymóg AppKit na macOS), czyli w `setup`.
pub fn apply(window: &WebviewWindow) -> AppliedEffect {
    AppliedEffect { effect: first_applied(window, candidates()), revealed: AtomicBool::new(false) }
}

/// Skrypt, który przekazuje UI przyjęty efekt; przy `None` nic nie robi i UI zostaje nieprzezroczyste.
fn ui_script(effect: WindowEffect) -> Option<String> {
    if effect == WindowEffect::None {
        return None;
    }
    let value = serde_json::to_string(&effect).ok()?;
    Some(format!("document.documentElement.setAttribute({ATTRIBUTE:?}, {value});"))
}

/// Po każdym załadowaniu strony (także po odświeżeniu) ustawia atrybut, a za pierwszym razem pokazuje okno.
pub fn on_page_load<R: Runtime>(webview: &Webview<R>, payload: &PageLoadPayload<'_>) {
    if payload.event() != PageLoadEvent::Finished {
        return;
    }
    let Some(applied) = webview.try_state::<AppliedEffect>() else {
        // Bez stanu z `setup` nie wiadomo nic o efekcie: okno pokazuje się z nieprzezroczystym UI.
        let _ = webview.window().show();
        return;
    };
    if let Some(script) = ui_script(applied.effect) {
        if let Err(err) = webview.eval(script) {
            eprintln!("[desktop] przekazanie efektu okna do UI: {err}");
        }
    }
    if !applied.revealed.swap(true, Ordering::SeqCst) {
        let window = webview.window();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn falls_back_to_next_effect_and_stops_at_first_success() {
        let calls = RefCell::new(Vec::new());
        let candidates: &[(WindowEffect, Apply<RefCell<Vec<&'static str>>, String>)] = &[
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
        assert_eq!(first_applied(&calls, candidates), WindowEffect::Acrylic);
        assert_eq!(*calls.borrow(), ["mica", "acrylic"]);
    }

    #[test]
    fn none_when_every_effect_is_rejected() {
        let rejected: &[(WindowEffect, Apply<(), String>)] =
            &[(WindowEffect::Mica, |_| Err("brak".into())), (WindowEffect::Acrylic, |_| Err("brak".into()))];
        assert_eq!(first_applied(&(), rejected), WindowEffect::None);
    }

    #[test]
    fn ui_script_sets_attribute_only_when_effect_applied() {
        assert_eq!(ui_script(WindowEffect::Mica).as_deref(), Some("document.documentElement.setAttribute(\"data-window-effect\", \"mica\");"));
        assert_eq!(ui_script(WindowEffect::None), None);
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
