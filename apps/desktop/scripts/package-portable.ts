/**
 * Pakuje wynik `pnpm build:desktop` do archiwum w `out/`:
 *
 *   Windows: trackwall-<wersja>-windows-x64.zip
 *     Trackwall/trackwall.exe          okno + tray (wymaga WebView2)
 *     Trackwall/trackwall-daemon.exe   daemon (sidecar)
 *     Trackwall/ui/                    UI dla trybu bez okna: trackwall-daemon.exe --ui
 *     Trackwall/README.txt
 *   macOS:   trackwall-<wersja>-macos-<arch>.zip z Trackwall.app
 *            trackwall-<wersja>-macos-<arch>.app.tar.gz, the same bundle as the update package (ADR-53)
 *
 * On Windows the zip itself is the update package. The release workflow signs both update packages.
 *
 * Bez instalatora i bez zapisu poza katalogiem użytkownika: archiwum rozpakowuje się gdziekolwiek.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertVersionsMatch, REPO, run, TAURI_DIR } from "./lib.ts";
import { PORTABLE_ENTRIES, UPDATE_PACKAGES } from "./update-manifest.ts";

const OUT = join(REPO, "out");
const version = assertVersionsMatch();

function need(path: string): string {
  if (!existsSync(path)) throw new Error(`brak ${path}; najpierw pnpm build:desktop`);
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
      "Daemon startup log: %USERPROFILE%\\.trackwall\\logs\\daemon-start.log",
      "",
    ].join("\r\n"),
  );
  const staged = readdirSync(stage).sort();
  if (staged.join() !== [...PORTABLE_ENTRIES].sort().join()) {
    throw new Error(`the build has ${staged.join(", ")}; update PORTABLE_ENTRIES and BUILD_ENTRIES (ADR-53)`);
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
  throw new Error("portable build jest tylko dla Windows i macOS");
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
