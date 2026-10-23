/**
 * Pakuje wynik `pnpm build:desktop` do archiwum w `out/`:
 *
 *   Windows: pitwall-<wersja>-windows-x64.zip
 *     Pitwall/pitwall.exe          okno + tray (wymaga WebView2)
 *     Pitwall/pitwall-daemon.exe   daemon (sidecar)
 *     Pitwall/ui/                  UI dla trybu bez okna: pitwall-daemon.exe --ui
 *     Pitwall/CZYTAJ.txt
 *   macOS:   pitwall-<wersja>-macos-<arch>.zip z Pitwall.app
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
  const stage = join(OUT, "stage", "Pitwall");
  mkdirSync(stage, { recursive: true });
  cpSync(need(join(release, "pitwall.exe")), join(stage, "pitwall.exe"));
  cpSync(need(join(release, "pitwall-daemon.exe")), join(stage, "pitwall-daemon.exe"));
  cpSync(need(join(REPO, "packages", "ui", "dist")), join(stage, "ui"), { recursive: true });
  writeFileSync(
    join(stage, "CZYTAJ.txt"),
    [
      `Pitwall ${version} (portable)`,
      "",
      "Uruchom pitwall.exe. Instalacja nie jest potrzebna, stan trafia do %USERPROFILE%\\.pitwall.",
      "",
      "Brak WebView2 albo okno się nie otwiera: uruchom pitwall-daemon.exe --ui,",
      "Pitwall otworzy się w domyślnej przeglądarce.",
      "",
      "Daemon działa po zamknięciu okna (ikona w zasobniku). Pełne wyjście: ikona w zasobniku > Wyjdź.",
      "Log startu daemona: %USERPROFILE%\\.pitwall\\logs\\daemon-start.log",
      "",
    ].join("\r\n"),
  );
  const zip = join(OUT, `pitwall-${version}-windows-x64.zip`);
  run(["tar", "-a", "-c", "-f", zip, "Pitwall"], join(OUT, "stage"));
  console.log(zip);
} else if (process.platform === "darwin") {
  const app = need(join(TAURI_DIR, "target", "release", "bundle", "macos", "Pitwall.app"));
  const zip = join(OUT, `pitwall-${version}-macos-${process.arch}.zip`);
  run(["ditto", "-c", "-k", "--keepParent", app, zip], OUT);
  console.log(zip);
} else {
  throw new Error("portable build jest tylko dla Windows i macOS");
}
