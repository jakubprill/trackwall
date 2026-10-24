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
      const files = Object.values(bundle).map((file) => ({
        fileName: file.fileName,
        code: file.type === "chunk" ? file.code : undefined,
      }));
      for (const fileName of unreferencedDraco(files)) delete bundle[fileName];
    },
  };
}

/** Pliki `draco_*` paczki (bez kodu, czyli zasoby), których nazwy nie ma w kodzie żadnego kawałka. */
export function unreferencedDraco(files: readonly { fileName: string; code: string | undefined }[]): string[] {
  const code = files.map((f) => f.code ?? "").join("\n");
  return files
    .filter((f) => f.code === undefined)
    .map((f) => f.fileName)
    .filter((fileName) => {
      const name = fileName.split("/").at(-1) ?? fileName;
      return name.startsWith("draco_") && !code.includes(name);
    });
}
