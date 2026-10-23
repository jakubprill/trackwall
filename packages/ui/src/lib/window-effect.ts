import { invoke, isTauri } from "@tauri-apps/api/core";
import { z } from "zod";

/**
 * Efekt tła okna, który system przyjął (ADR-11, `apps/desktop/src-tauri/src/window_effect.rs`).
 * Okno Tauri jest przezroczyste, więc UI zdejmuje własne tło tylko wtedy, gdy pod spodem jest efekt;
 * przy `none`, w przeglądarce i przy każdym błędzie zostaje nieprzezroczyste tło z `index.css`.
 */
export const WindowEffect = z.enum(["mica", "acrylic", "vibrancy", "none"]);
export type WindowEffect = z.infer<typeof WindowEffect>;

/** Atrybut na `<html>`, od którego `index.css` przełącza kolory na półprzezroczyste. */
export const WINDOW_EFFECT_ATTRIBUTE = "data-window-effect";

export async function resolveWindowEffect(): Promise<WindowEffect> {
  if (!isTauri()) return "none";
  return WindowEffect.parse(await invoke("window_effect"));
}

export function applyWindowEffect(effect: WindowEffect, root: Pick<Element, "setAttribute" | "removeAttribute">): void {
  if (effect === "none") root.removeAttribute(WINDOW_EFFECT_ATTRIBUTE);
  else root.setAttribute(WINDOW_EFFECT_ATTRIBUTE, effect);
}
