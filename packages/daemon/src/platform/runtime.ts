/**
 * The platform layer: the only place where daemon code may check whether it runs under Bun or Node
 * (ADR-1). Modules outside `platform/` use only `node:` APIs.
 */
export interface RuntimeInfo {
  name: "bun" | "node";
  version: string;
}

/**
 * Whether the daemon runs as a binary from `bun build --compile`. The script then lies in Bun's virtual file system
 * (`/$bunfs/root/…`, on Windows `B:\~BUN\root\…`), which `node:fs` in Bun also sees, so `existsSync` does not settle it.
 */
export function isCompiledBinary(): boolean {
  return isInBinary(process.argv[1] ?? "");
}

/** Whether a path points to a file embedded in a binary from `bun build --compile` (Bun's virtual file system). */
export function isInBinary(path: string): boolean {
  return /[\\/]\$bunfs[\\/]|~BUN[\\/]/.test(path);
}

export function runtimeInfo(): RuntimeInfo {
  const bun = (process.versions as Record<string, string | undefined>).bun;
  return bun ? { name: "bun", version: bun } : { name: "node", version: process.versions.node };
}
