import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const REPO = join(import.meta.dir, "..", "..", "..");
export const DESKTOP = join(REPO, "apps", "desktop");
export const TAURI_DIR = join(DESKTOP, "src-tauri");

/** The host triple from `rustc -vV`; Tauri names sidecars the same way. */
export function hostTriple(): string {
  const out = run(["rustc", "-vV"], REPO, true);
  const line = out.split("\n").find((l) => l.startsWith("host: "));
  if (!line) throw new Error("rustc -vV did not report the host");
  return line.slice("host: ".length).trim();
}

export function run(cmd: string[], cwd: string, capture = false): string {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: capture ? "pipe" : "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) throw new Error(`${cmd.join(" ")} exited with code ${proc.exitCode}`);
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

/** The `version` field from a JSON file (package.json, tauri.conf.json). */
export function jsonVersion(path: string): string {
  return parseFile(path, JsonManifest, JSON.parse).version;
}

/** The app identifier from tauri.conf.json, which is also the AppUserModelID of its notifications on Windows (ADR-50). */
export function tauriIdentifier(): string {
  return parseFile(join(TAURI_DIR, "tauri.conf.json"), z.object({ identifier: z.string() }), JSON.parse).identifier;
}

/** `[package].version` from Cargo.toml. */
export function cargoVersion(path: string): string {
  return parseFile(path, CargoManifest, Bun.TOML.parse).package.version;
}

/** The version must be the same in the daemon, Tauri and Cargo: the shell compares it with `/api/health`. */
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
      `versions differ:\n${Object.entries(v)
        .map(([f, x]) => `  ${f}: ${x}`)
        .join("\n")}`,
    );
  }
  return version;
}
