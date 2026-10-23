import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

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

const JsonManifest = z.object({ version: z.string().min(1) });
const CargoManifest = z.object({ package: z.object({ version: z.string().min(1) }) });

export function parseFile<T>(path: string, schema: z.ZodType<T>, parse: (text: string) => unknown): T {
  const text = readFileSync(path, "utf8");
  let data: unknown;
  try {
    data = parse(text);
  } catch (err) {
    throw new Error(`${path}: ${(err as Error).message}`, { cause: err });
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(`${path}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Pole `version` z pliku JSON (package.json, tauri.conf.json). */
export function jsonVersion(path: string): string {
  return parseFile(path, JsonManifest, JSON.parse).version;
}

/** `[package].version` z Cargo.toml. */
export function cargoVersion(path: string): string {
  return parseFile(path, CargoManifest, Bun.TOML.parse).package.version;
}

/** Wersja musi być ta sama w daemonie, Tauri i Cargo: powłoka porównuje ją z `/api/health`. */
function versions(): Record<string, string> {
  const manifests = {
    "packages/daemon/package.json": jsonVersion,
    "apps/desktop/src-tauri/tauri.conf.json": jsonVersion,
    "apps/desktop/src-tauri/Cargo.toml": cargoVersion,
  };
  return Object.fromEntries(Object.entries(manifests).map(([path, read]) => [path, read(join(REPO, ...path.split("/")))]));
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
