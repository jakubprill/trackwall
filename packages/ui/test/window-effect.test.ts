import { describe, expect, test } from "bun:test";
import { applyWindowEffect, resolveWindowEffect, WindowEffect } from "../src/lib/window-effect.ts";

function fakeRoot() {
  const attrs = new Map<string, string>();
  return {
    attrs,
    setAttribute: (name: string, value: string) => void attrs.set(name, value),
    removeAttribute: (name: string) => void attrs.delete(name),
  };
}

describe("efekt tła okna", () => {
  test("przyjęty efekt trafia do atrybutu na <html>, a „none” go zdejmuje", () => {
    const root = fakeRoot();
    applyWindowEffect("mica", root);
    expect(root.attrs.get("data-window-effect")).toBe("mica");
    applyWindowEffect("none", root);
    expect(root.attrs.has("data-window-effect")).toBe(false);
  });

  test("poza oknem Tauri efektu nie ma, więc tło zostaje nieprzezroczyste", async () => {
    expect(await resolveWindowEffect()).toBe("none");
  });

  test("nieznana nazwa efektu z powłoki jest odrzucana zamiast włączać przezroczystość", () => {
    expect(WindowEffect.safeParse("vibrancy").success).toBe(true);
    expect(WindowEffect.safeParse("liquid-glass").success).toBe(false);
  });
});
