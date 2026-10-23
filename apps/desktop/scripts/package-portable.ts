/**
 * Pakuje wynik `pnpm build:desktop` do archiwum w `out/`:
 *
 *   Windows: trackwall-<wersja>-windows-x64.zip
 *     Trackwall/trackwall.exe          okno + tray (wymaga WebView2)
 *     Trackwall/trackwall-daemon.exe   daemon (sidecar)
 *     Trackwall/ui/                  UI dla trybu bez okna: trackwall-daemon.exe --ui
 *     Trackwall/CZYTAJ.txt
 *   macOS:   trackwall-<wersja>-macos-<arch>.zip z Trackwall.app
 *
 * Bez instalatora i bez zapisu poza katalogiem użytkownika: archiwum rozpakowuje się gdziekolwiek.
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertVersionsMatch, REPO, run, TAURI_DIR } from "./lib.ts";

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
    join(stage, "CZYTAJ.txt"),
    [
      `Trackwall ${version} (portable)`,
      "",
      "Uruchom trackwall.exe. Instalacja nie jest potrzebna, stan trafia do %USERPROFILE%\\.trackwall.",
      "",
      "Brak WebView2 albo okno się nie otwiera: uruchom trackwall-daemon.exe --ui,",
      "Trackwall otworzy się w domyślnej przeglądarce.",
      "",
      "Daemon działa po zamknięciu okna (ikona w zasobniku). Pełne wyjście: ikona w zasobniku > Wyjdź.",
      "Log startu daemona: %USERPROFILE%\\.trackwall\\logs\\daemon-start.log",
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
