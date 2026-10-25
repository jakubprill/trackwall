/**
 * Pakuje wynik `pnpm build:desktop` do archiwum w `out/`:
 *
 *   Windows: trackwall-<wersja>-windows-x64.zip
 *     Trackwall/trackwall.exe          okno + tray (wymaga WebView2)
 *     Trackwall/trackwall-daemon.exe   daemon (sidecar)
 *     Trackwall/ui/                    UI dla trybu bez okna: trackwall-daemon.exe --ui
 *     Trackwall/README.txt
 *   macOS:   trackwall-<wersja>-macos-<arch>.zip z Trackwall.app
 *
 * No installer: the archive unpacks anywhere. Outside the user's folders Trackwall writes only the notification
 * registration in HKCU on Windows (ADR-50), which README.txt mentions.
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertVersionsMatch, REPO, run, TAURI_DIR, tauriIdentifier } from "./lib.ts";

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
  const zip = join(OUT, `trackwall-${version}-windows-x64.zip`);
  run(["tar", "-a", "-c", "-f", zip, "Trackwall"], join(OUT, "stage"));
  console.log(zip);
} else if (process.platform === "darwin") {
  const app = need(join(TAURI_DIR, "target", "release", "bundle", "macos", "Trackwall.app"));
  const zip = join(OUT, `trackwall-${version}-macos-${process.arch}.zip`);
  run(["ditto", "-c", "-k", "--keepParent", app, zip], OUT);
  console.log(zip);
} else {
  throw new Error("portable build jest tylko dla Windows i macOS");
}
