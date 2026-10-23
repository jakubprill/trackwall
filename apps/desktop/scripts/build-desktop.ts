/**
 * Build aplikacji desktopowej dla bieżącej platformy:
 *   Windows: `trackwall.exe` bez instalatora (`--no-bundle`), sidecar obok,
 *   macOS:   `Trackwall.app` (bundle `app`, bez dmg i bez podpisu).
 * Pakowanie do archiwum robi `scripts/package-portable.ts` (`pnpm portable`).
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
