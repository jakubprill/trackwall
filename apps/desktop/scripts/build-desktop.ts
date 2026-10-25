/**
 * Builds the desktop app for the current platform:
 *   Windows: `trackwall.exe` without an installer (`--no-bundle`), the sidecar next to it,
 *   macOS:   `Trackwall.app` (the `app` bundle, without dmg and without signing).
 * `scripts/package-portable.ts` (`pnpm portable`) packs it into an archive.
 */
import { assertVersionsMatch, DESKTOP, REPO, run } from "./lib.ts";

const version = assertVersionsMatch();
console.log(`Trackwall ${version}`);
run(["pnpm", "--filter", "@trackwall/ui", "build"], REPO);
run(["bun", "scripts/sidecar.ts"], DESKTOP);
const tauri = ["pnpm", "exec", "tauri", "build", "--ci"];
if (process.platform === "win32") tauri.push("--no-bundle");
else tauri.push("--bundles", "app");
run(tauri, DESKTOP);
