/**
 * Build aplikacji desktopowej dla bieżącej platformy:
 *   Windows: `pitwall.exe` bez instalatora (`--no-bundle`), sidecar obok,
 *   macOS:   `Pitwall.app` (bundle `app`, bez dmg i bez podpisu).
 * Pakowanie do archiwum robi `scripts/package-portable.ts` (`pnpm portable`).
 */
import { join } from "node:path";
import { assertVersionsMatch, REPO, run } from "./lib.ts";

const version = assertVersionsMatch();
console.log(`Pitwall ${version}`);
run(["pnpm", "--filter", "@pitwall/ui", "build"], REPO);
run(["bun", "scripts/sidecar.ts"], join(REPO, "apps", "desktop"));
const tauri = ["pnpm", "exec", "tauri", "build", "--ci"];
if (process.platform === "win32") tauri.push("--no-bundle");
else tauri.push("--bundles", "app");
run(tauri, join(REPO, "apps", "desktop"));
