import type { Plugin } from "vite";

/**
 * Tylko `vite build`: usuwa z paczki pliki dekodera Draco, do których nie prowadzi żaden kawałek kodu. `DRACOLoader`
 * z three.js (przez loader glTF w Pawn) zgłasza je przez `new URL(..., import.meta.url)`, więc trafiają do `dist`
 * nawet wtedy, gdy sam loader wypadł przy tree-shakingu, a pulpit nie ładuje glTF (ADR-33). Bez tego każda paczka
 * Tauri i portable build wiozłyby około 1,3 MB martwych plików. Plik, do którego coś się odwołuje, zostaje.
 */
export function dropUnreferencedDraco(): Plugin {
  return {
    name: "trackwall:drop-unreferenced-draco",
    apply: "build",
    generateBundle(_options, bundle) {
      const code = Object.values(bundle)
        .map((file) => (file.type === "chunk" ? file.code : ""))
        .join("\n");
      for (const [fileName, file] of Object.entries(bundle)) {
        const name = fileName.split("/").at(-1) ?? fileName;
        if (file.type === "asset" && name.startsWith("draco_") && !code.includes(name)) delete bundle[fileName];
      }
    },
  };
}
