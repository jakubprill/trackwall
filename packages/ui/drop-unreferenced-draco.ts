import type { Plugin } from "vite";

/**
 * Only `vite build`: removes from the bundle the Draco decoder files no chunk of code leads to. three.js's `DRACOLoader`
 * (through the glTF loader in Pawn) references them with `new URL(..., import.meta.url)`, so they land in `dist` even
 * when the loader itself was tree-shaken away, and the dashboard loads no glTF (ADR-33). Without this every Tauri bundle
 * and portable build would carry about 1.3 MB of dead files. A file something refers to stays.
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

/** The bundle's `draco_*` files (not code, so assets) whose names appear in no chunk's code. */
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
