/**
 * Builds the daemon into a single binary with `bun build --compile`.
 *
 *   bun scripts/build.ts                 a binary for the current platform
 *   bun scripts/build.ts --target all    all supported platforms (cross-compilation)
 *   bun scripts/build.ts --target x86_64-pc-windows-msvc
 *
 * Output: `dist/trackwall-daemon-<triple>[.exe]`, exactly the name Tauri expects of the sidecar.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const TARGETS = {
  "x86_64-pc-windows-msvc": { bun: "bun-windows-x64", exe: true },
  "aarch64-apple-darwin": { bun: "bun-darwin-arm64", exe: false },
  "x86_64-apple-darwin": { bun: "bun-darwin-x64", exe: false },
  "x86_64-unknown-linux-gnu": { bun: "bun-linux-x64", exe: false },
} as const;
type Triple = keyof typeof TARGETS;

function isTriple(value: string): value is Triple {
  return Object.hasOwn(TARGETS, value);
}

function hostTriple(): Triple {
  const key = `${process.platform}-${process.arch}`;
  const map: Record<string, Triple> = {
    "win32-x64": "x86_64-pc-windows-msvc",
    "darwin-arm64": "aarch64-apple-darwin",
    "darwin-x64": "x86_64-apple-darwin",
    "linux-x64": "x86_64-unknown-linux-gnu",
  };
  const triple = map[key];
  if (!triple) throw new Error(`unsupported platform ${key}`);
  return triple;
}

const { values } = parseArgs({ args: Bun.argv.slice(2), options: { target: { type: "string" } } });
const requested = values.target ?? hostTriple();
if (requested !== "all" && !isTriple(requested)) {
  throw new Error(`unknown target ${requested}; available: all, ${Object.keys(TARGETS).join(", ")}`);
}
const triples = requested === "all" ? Object.keys(TARGETS).filter(isTriple) : [requested];

const root = join(import.meta.dir, "..");
const outDir = join(root, "dist");
mkdirSync(outDir, { recursive: true });

for (const triple of triples) {
  const target = TARGETS[triple];
  const outfile = join(outDir, `trackwall-daemon-${triple}${target.exe ? ".exe" : ""}`);
  const proc = Bun.spawnSync(
    [
      "bun",
      "build",
      "--compile",
      // The binary also starts in someone else's directory (the MCP bridge in the repo the agent works in), so it does not
      // read its `.env` or `bunfig.toml`: a repo cannot set the daemon's variables or runtime options.
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--minify",
      "--sourcemap",
      `--target=${target.bun}`,
      "src/main.ts",
      "--outfile",
      outfile,
    ],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
  );
  if (proc.exitCode !== 0) process.exit(proc.exitCode ?? 1);
  console.log(`built ${outfile}`);
}
