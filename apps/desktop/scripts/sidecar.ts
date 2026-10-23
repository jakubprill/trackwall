/** Buduje daemon dla hosta i kładzie go tam, gdzie Tauri szuka sidecara (`binaries/trackwall-daemon-<triple>`). */
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { hostTriple, REPO, run, TAURI_DIR } from "./lib.ts";

const triple = process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTriple();
const exe = triple.includes("windows") ? ".exe" : "";
run(["bun", "scripts/build.ts", "--target", triple], join(REPO, "packages", "daemon"));
const name = `trackwall-daemon-${triple}${exe}`;
const dir = join(TAURI_DIR, "binaries");
mkdirSync(dir, { recursive: true });
copyFileSync(join(REPO, "packages", "daemon", "dist", name), join(dir, name));
console.log(`sidecar: ${join(dir, name)}`);
