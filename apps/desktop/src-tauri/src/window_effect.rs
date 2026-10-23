//! Półprzezroczyste tło okna (ADR-11): Mica na Windows 11, Acrylic na Windows 10, vibrancy na macOS.
//!
//! Okno jest przezroczyste (`transparent` w `tauri.conf.json`), więc bez efektu byłoby widać przez nie pulpit.
//! Dlatego UI dostaje nazwę efektu, który system faktycznie przyjął, i dopiero wtedy zdejmuje własne tło;
//! przy `None` maluje je nieprzezroczyste. `set_effects` z Tauri nie nadaje się tu, bo bierze tylko pierwszy
//! efekt z listy i nie mówi, czy się udał.

use serde::Serialize;
use std::fmt::Display;

/// Efekt tła widziany przez UI (`packages/ui/src/lib/window-effect.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowEffect {
    Mica,
    Acrylic,
    Vibrancy,
    None,
}

type Apply<W, E> = fn(&W) -> Result<(), E>;

/// Próbuje efektów po kolei i zwraca pierwszy przyjęty; odrzucone trafiają do logu powłoki.
fn first_applied<W, E: Display>(window: &W, candidates: &[(WindowEffect, Apply<W, E>)]) -> WindowEffect {
    for (effect, apply) in candidates {
        match apply(window) {
            Ok(()) => return *effect,
            Err(err) => eprintln!("[desktop] efekt okna {effect:?} niedostępny: {err}"),
        }
    }
    WindowEffect::None
}

/// Kolor UI (`--background` w `index.css`) z kryciem ok. 70%: Acrylic sam w sobie jest jasny i bez tego
/// tekst na nim słabo się czyta.
#[cfg(windows)]
const ACRYLIC_TINT: (u8, u8, u8, u8) = (9, 9, 11, 180);

/// Musi działać na wątku głównym (wymóg AppKit na macOS), czyli w `setup`.
pub fn apply(window: &tauri::WebviewWindow) -> WindowEffect {
    // Mica nie ma problemów z wydajnością, ale wymaga Windows 11. Acrylic działa od Windows 10 1809,
    // za to przy przeciąganiu okna na Windows 10 1903+ potrafi przycinać (dokumentacja window-vibrancy).
    #[cfg(windows)]
    let candidates: &[(WindowEffect, Apply<tauri::WebviewWindow, window_vibrancy::Error>)] = &[
        (WindowEffect::Mica, |w| window_vibrancy::apply_mica(w, Some(true))),
        (WindowEffect::Acrylic, |w| window_vibrancy::apply_acrylic(w, Some(ACRYLIC_TINT))),
    ];
    #[cfg(target_os = "macos")]
    let candidates: &[(WindowEffect, Apply<tauri::WebviewWindow, window_vibrancy::Error>)] = &[(WindowEffect::Vibrancy, |w| {
        use window_vibrancy::{NSVisualEffectMaterial, NSVisualEffectState};
        window_vibrancy::apply_vibrancy(w, NSVisualEffectMaterial::UnderWindowBackground, Some(NSVisualEffectState::FollowsWindowActiveState), None)
    })];
    // Linux nie jest platformą docelową (§9); kompozytor i tak decyduje tam o przezroczystości sam.
    #[cfg(not(any(windows, target_os = "macos")))]
    let candidates: &[(WindowEffect, Apply<tauri::WebviewWindow, String>)] = &[];

    first_applied(window, candidates)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn serializes_as_lowercase_names_for_ui() {
        assert_eq!(serde_json::to_string(&WindowEffect::Mica).unwrap(), "\"mica\"");
        assert_eq!(serde_json::to_string(&WindowEffect::None).unwrap(), "\"none\"");
    }

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
        assert_eq!(first_applied::<(), String>(&(), &[]), WindowEffect::None);
    }
}
