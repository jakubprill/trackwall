/**
 * Warstwa platformy: jedyne miejsce, w którym kod daemona może sprawdzać, czy działa pod Bun czy Node
 * (ADR-1). Moduły poza `platform/` używają wyłącznie API `node:`.
 */
export interface RuntimeInfo {
  name: "bun" | "node";
  version: string;
}

export function runtimeInfo(): RuntimeInfo {
  const bun = (process.versions as Record<string, string | undefined>).bun;
  return bun ? { name: "bun", version: bun } : { name: "node", version: process.versions.node };
}
