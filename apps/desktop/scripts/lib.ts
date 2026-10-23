import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const REPO = join(import.meta.dir, "..", "..", "..");
const DESKTOP = join(REPO, "apps", "desktop");
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

const Versioned = z.object({ version: z.string().min(1) });

function jsonVersion(path: string): string {
  const parsed = Versioned.safeParse(JSON.parse(readFileSync(join(REPO, path), "utf8")));
  if (!parsed.success) throw new Error(`${path}: brak pola version (${parsed.error.message})`);
  return parsed.data.version;
}

function cargoVersion(path: string): string {
  const version = readFileSync(join(REPO, path), "utf8").match(/^version\s*=\s*"([^"]+)"/m)?.[1];
  if (!version) throw new Error(`${path}: brak version w [package]`);
  return version;
}

/** Wersja musi być ta sama w daemonie, Tauri i Cargo: powłoka porównuje ją z `/api/health`. */
export function versions(): Record<string, string> {
  return {
    "packages/daemon/package.json": jsonVersion("packages/daemon/package.json"),
    "apps/desktop/src-tauri/tauri.conf.json": jsonVersion("apps/desktop/src-tauri/tauri.conf.json"),
    "apps/desktop/src-tauri/Cargo.toml": cargoVersion("apps/desktop/src-tauri/Cargo.toml"),
  };
}

export function assertVersionsMatch(): string {
  const v = versions();
  const [version, ...others] = new Set(Object.values(v));
  if (!version || others.length > 0) {
    throw new Error(
      `różne wersje:\n${Object.entries(v)
        .map(([f, x]) => `  ${f}: ${x}`)
        .join("\n")}`,
    );
  }
  return version;
}
