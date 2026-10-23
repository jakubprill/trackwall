import { readFileSync } from "node:fs";
import { join } from "node:path";

export const REPO = join(import.meta.dir, "..", "..", "..");
export const DESKTOP = join(REPO, "apps", "desktop");
export const TAURI_DIR = join(DESKTOP, "src-tauri");

/** Triple hosta z `rustc -vV`; tak samo nazywa sidecary Tauri. */
export function hostTriple(): string {
  const out = run(["rustc", "-vV"], REPO, true);
  const line = out.split("\n").find((l) => l.startsWith("host: "));
  if (!line) throw new Error("rustc -vV nie podał hosta");
  return line.slice("host: ".length).trim();
}

export function run(cmd: string[], cwd: string, capture = false): string {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: capture ? "pipe" : "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) throw new Error(`${cmd.join(" ")} zakończył się kodem ${proc.exitCode}`);
  return capture ? (proc.stdout?.toString() ?? "") : "";
}

/** Wersja musi być ta sama w daemonie, Tauri i Cargo: powłoka porównuje ją z `/api/health`. */
export function versions(): Record<string, string> {
  const json = (p: string) => JSON.parse(readFileSync(join(REPO, p), "utf8")).version as string;
  const cargo = readFileSync(join(TAURI_DIR, "Cargo.toml"), "utf8").match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? "?";
  return {
    "packages/daemon/package.json": json("packages/daemon/package.json"),
    "apps/desktop/src-tauri/tauri.conf.json": json("apps/desktop/src-tauri/tauri.conf.json"),
    "apps/desktop/src-tauri/Cargo.toml": cargo,
  };
}

export function assertVersionsMatch(): string {
  const v = versions();
  const unique = new Set(Object.values(v));
  if (unique.size !== 1) {
    throw new Error(
      `różne wersje:\n${Object.entries(v)
        .map(([f, x]) => `  ${f}: ${x}`)
        .join("\n")}`,
    );
  }
  return [...unique][0] as string;
}
