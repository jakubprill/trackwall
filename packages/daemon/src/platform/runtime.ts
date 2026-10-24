/**
 * Warstwa platformy: jedyne miejsce, w którym kod daemona może sprawdzać, czy działa pod Bun czy Node
 * (ADR-1). Moduły poza `platform/` używają wyłącznie API `node:`.
 */
export interface RuntimeInfo {
  name: "bun" | "node";
  version: string;
}

/**
 * Czy daemon działa jako binarka z `bun build --compile`. Skrypt leży wtedy w wirtualnym systemie plików Bun
 * (`/$bunfs/root/…`, na Windowsie `B:\~BUN\root\…`), który `node:fs` w Bun też widzi, więc `existsSync` tego nie rozstrzyga.
 */
export function isCompiledBinary(): boolean {
  return isInBinary(process.argv[1] ?? "");
}

/** Czy ścieżka wskazuje plik osadzony w binarce z `bun build --compile` (wirtualny system plików Bun). */
export function isInBinary(path: string): boolean {
  return /[\\/]\$bunfs[\\/]|~BUN[\\/]/.test(path);
}

export function runtimeInfo(): RuntimeInfo {
  const bun = (process.versions as Record<string, string | undefined>).bun;
  return bun ? { name: "bun", version: bun } : { name: "node", version: process.versions.node };
}
