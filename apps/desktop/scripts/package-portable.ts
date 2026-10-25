/**
 * Packs the output of `pnpm build:desktop` into an archive in `out/`:
 *
 *   Windows: trackwall-<version>-windows-x64.zip
 *     Trackwall/trackwall.exe          window + tray (needs WebView2)
 *     Trackwall/trackwall-daemon.exe   daemon (sidecar)
 *     Trackwall/ui/                    UI for the windowless mode: trackwall-daemon.exe --ui
 *     Trackwall/README.txt
 *   macOS:   trackwall-<version>-macos-<arch>.zip with Trackwall.app
 *            trackwall-<version>-macos-<arch>.app.tar.gz, the same bundle as the update package (ADR-53)
 *
 * On Windows the zip itself is the update package. The release workflow signs both update packages.
 *
 * No installer: the archive unpacks anywhere. Outside the user's folders Trackwall writes only the notification
 * registration in HKCU on Windows (ADR-50), which README.txt mentions.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertVersionsMatch, BUILD_ENTRIES, REPO, run, TAURI_DIR, tauriIdentifier } from "./lib.ts";
import { UPDATE_PACKAGES } from "./update-manifest.ts";

const OUT = join(REPO, "out");
const version = assertVersionsMatch();

function need(path: string): string {
  if (!existsSync(path)) throw new Error(`${path} is missing; run pnpm build:desktop first`);
  return path;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

if (process.platform === "win32") {
  const release = join(TAURI_DIR, "target", "release");
  const stage = join(OUT, "stage", "Trackwall");
  mkdirSync(stage, { recursive: true });
  cpSync(need(join(release, "trackwall.exe")), join(stage, "trackwall.exe"));
  cpSync(need(join(release, "trackwall-daemon.exe")), join(stage, "trackwall-daemon.exe"));
  cpSync(need(join(REPO, "packages", "ui", "dist")), join(stage, "ui"), { recursive: true });
  writeFileSync(
    join(stage, "README.txt"),
    [
      `Trackwall ${version} (portable)`,
      "",
      "Run trackwall.exe. No installation needed; state goes to %USERPROFILE%\\.trackwall.",
      "",
      "No WebView2, or the window does not open: run trackwall-daemon.exe --ui,",
      "and Trackwall opens in your default browser.",
      "",
      "The daemon keeps running after you close the window (tray icon). To quit fully: tray icon > Quit.",
      "Updates: Trackwall checks for a new version and installs it when you click (Settings > Updates).",
      "",
      "trackwall.exe registers trackwall:// links for your user at every start (HKCU\\Software\\Classes\\trackwall).",
      "After deleting the folder, remove that registry key to forget them.",
      "",
      "Daemon startup log: %USERPROFILE%\\.trackwall\\logs\\daemon-start.log",
      "",
      "For its notifications Trackwall registers itself under this registry key:",
      `HKEY_CURRENT_USER\\Software\\Classes\\AppUserModelId\\${tauriIdentifier()}`,
      "Delete it after removing Trackwall if you want no trace of it.",
      "",
    ].join("\r\n"),
  );
  const staged = readdirSync(stage).sort();
  if (staged.join() !== [...BUILD_ENTRIES].sort().join()) {
    throw new Error(`the build has ${staged.join(", ")}; update BUILD_ENTRIES in scripts/lib.ts and in portable_update.rs (ADR-53)`);
  }
  const zip = join(OUT, UPDATE_PACKAGES["windows-x86_64"](version));
  run(["tar", "-a", "-c", "-f", zip, "Trackwall"], join(OUT, "stage"));
  console.log(zip);
} else if (process.platform === "darwin") {
  const bundles = join(TAURI_DIR, "target", "release", "bundle", "macos");
  const app = need(join(bundles, "Trackwall.app"));
  const zip = join(OUT, `trackwall-${version}-macos-${process.arch}.zip`);
  run(["ditto", "-c", "-k", "--keepParent", app, zip], OUT);
  console.log(zip);
  if (process.arch === "arm64") packUpdate(bundles, join(OUT, UPDATE_PACKAGES["darwin-aarch64"](version)));
} else {
  throw new Error("the portable build is only for Windows and macOS");
}

/**
 * The macOS update package: the updater plugin unpacks a gzip tar and drops its top folder, so the bundle must be the
 * only entry at the top. Without `--no-mac-metadata` tar adds `._*` files with extended attributes to the bundle.
 */
function packUpdate(bundles: string, update: string) {
  run(["tar", "--no-mac-metadata", "-czf", update, "-C", bundles, "Trackwall.app"], OUT);
  const entries = run(["tar", "-tzf", update], OUT, true).split("\n").filter(Boolean);
  const stray = entries.filter((entry) => !entry.startsWith("Trackwall.app/") || entry.split("/").some((part) => part.startsWith("._")));
  if (stray.length > 0) throw new Error(`${update} has entries outside Trackwall.app: ${stray.slice(0, 5).join(", ")}`);
  console.log(update);
}
