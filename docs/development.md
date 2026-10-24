# Rozwój

Układ repo, uruchomienie ze źródeł i narzędzia dla osób, które rozwijają Trackwall. Dokumentacja projektu (po polsku, ADR-32):

- [Funkcje](features.md)
- [Architektura](architecture.md)
- [Zasady dla agentów i Definition of done](../AGENTS.md)
- [Słownik pojęć](../CONTEXT.md)
- [Wydania i instalacja](release.md)

## Układ repo

| Ścieżka | Co to jest |
|---|---|
| `packages/protocol` | typy i schematy zod wspólne dla daemona, UI i CLI |
| `packages/daemon` | daemon (Bun, kod zgodny z Node), budowany do jednej binarki; `src/modules/` to moduły z §4 architektury, `src/api/` i `src/mcp/` transporty, `src/platform/` API systemu, `src/infra/` reszta infrastruktury |
| `packages/ui` | React + Tailwind + shadcn/ui, Vite; `src/views/<widok>/` to widoki z paska po lewej, `src/components/` wspólne komponenty, `src/lib/` logika bez Reacta i hooki |
| `apps/desktop` | powłoka Tauri 2: okno (półprzezroczyste, ADR-11), tray, start i zatrzymanie daemona |

## Uruchomienie ze źródeł

Wymagane: Node 22.12+, pnpm 10, Bun 1.4, a dla aplikacji desktopowej Rust (wersje w `mise.toml`, `mise install` je ustawia). Na Windowsie aplikacja desktopowa wymaga też Visual Studio Build Tools z obciążeniem „Desktop development with C++”, których mise nie instaluje.

Z mise: `mise install`, potem `mise run dev` (zależności i tryb deweloperski) albo `mise run portable` (zależności i portable build do `out/`); `mise run setup` instaluje same zależności, `mise tasks` pokazuje listę.

Na Windowsie bez Build Tools Rust znajduje inny `link.exe` z PATH (np. z coreutils albo Git) i build Tauri kończy się błędem linkera. UI w przeglądarce (`pnpm dev`) działa bez nich.

```sh
pnpm install
pnpm dev                       # daemon (bun --watch, stan w .trackwall-dev/) + Vite na http://127.0.0.1:5173
pnpm --filter @trackwall/desktop dev   # to samo w oknie Tauri (stan w ~/.trackwall-dev, osobno od wydania)
pnpm lint                      # Biome i knip (pnpm format poprawia formatowanie)
pnpm test                      # testy wszystkich paczek
```

Sam daemon z UI w przeglądarce, bez Tauri:

```sh
pnpm build
bun packages/daemon/src/main.ts --ui
```

Ten sam daemon działa też pod samym Node, bez Bun (ADR-1): `pnpm --filter @trackwall/ui build`, potem `pnpm --filter @trackwall/daemon start:node`.

## Portable build

```sh
pnpm build:desktop   # UI, daemon jako binarka, Tauri bez instalatora
pnpm portable        # out/trackwall-<wersja>-windows-x64.zip albo out/trackwall-<wersja>-macos-<arch>.zip
```

Windows: zip zawiera `trackwall.exe`, `trackwall-daemon.exe` i `ui/`. Rozpakowanie i uruchomienie `trackwall.exe` wystarcza; stan trafia do `%USERPROFILE%\.trackwall`. Bez WebView2 `trackwall.exe` pokazuje komunikat, a `trackwall-daemon.exe --ui` otwiera Trackwall w przeglądarce. Pliki nie są podpisane, więc SmartScreen pokaże ostrzeżenie (podpis jest zaplanowany przed publikacją, §9).

macOS: zip zawiera niepodpisany `Trackwall.app`; pierwsze uruchomienie przez prawy klik > Otwórz albo `xattr -dr com.apple.quarantine Trackwall.app`.

Każdy przebieg CI (PR, push na `main`, ręczne uruchomienie) publikuje oba archiwa jako artefakty.

## Ikony

Źródłem ikon są `apps/desktop/assets/icon.svg` (ikona aplikacji) i `apps/desktop/assets/tray-icon.svg` (jednobarwny znak traya). Po zmianie któregoś z nich:

```sh
pnpm --filter @trackwall/desktop icons   # ikony z bundle.icon w tauri.conf.json, szablon traya dla macOS i favicon UI
```

Wygenerowane pliki trafiają do repo razem ze zmienionym SVG. `tauri icon` zapisuje `icon.icns` za każdym razem w innej kolejności wpisów, więc zmieniony `icon.icns` po przebiegu bez zmiany SVG odrzuć (`git checkout -- apps/desktop/src-tauri/icons/icon.icns`).

## Nagrywanie sesji Copilot CLI

Prototyp wykrywania stanu zadania (ADR-17), do zbierania nagrań. Skrypt uruchamia Copilot CLI w PTY tak jak daemon w widoku „Sessions”, pokazuje go w bieżącym terminalu, nagrywa i liczy stan (`Working`, `Input`, `Approval`…). Wymaga Bun i zainstalowanego, zalogowanego `copilot` w `PATH` (na Windowsie zarówno `copilot.exe`, jak i `copilot.cmd` z `npm install -g`). Uruchom go w katalogu repo, w którym ma pracować agent, z `bun --no-env-file`, żeby Bun nie wczytał `.env` repo do środowiska Copilot CLI (Bun nadal czyta `bunfig.toml` z bieżącego katalogu, więc w repo z `bunfig.toml` uruchom skrypt z `--config` wskazującym inny plik):

```sh
bun --no-env-file <trackwall>/packages/daemon/scripts/copilot-record.ts record                         # zwykła sesja interaktywna
bun --no-env-file <trackwall>/packages/daemon/scripts/copilot-record.ts record -- -i "Opisz to repo"   # argumenty po -- idą do copilot
bun <trackwall>/packages/daemon/scripts/copilot-record.ts replay <katalog>/session.cast                # stan policzony jeszcze raz z nagrania
```

Po wyjściu z Copilot CLI skrypt drukuje listę zmian stanu i katalog nagrania (domyślnie `~/.trackwall/recordings/<czas>` albo `$TRACKWALL_HOME/recordings/<czas>`, inny przez `--out`): `session.cast` (asciicast v2, do odtworzenia w asciinema), `states.jsonl`, `hooks.jsonl` i `plugin/` z hookami podanymi przez `--plugin-dir`. Stany na żywo widać w drugim terminalu: `tail -f <katalog>/states.jsonl` albo w PowerShell `Get-Content -Wait <katalog>\states.jsonl`. Nagranie zawiera wszystko, co było na ekranie, więc przed dodaniem go do repo jako fixture trzeba je zanonimizować; wpisywane klawisze, prompty oraz argumenty i wyniki narzędzi z hooków nie są zapisywane, ale tytuł i treść powiadomienia (każde do 200 znaków) tak, a prośba o zgodę zawiera w nich komendę albo pełną ścieżkę, o którą prosi agent. Żeby nagrać prośbę o zgodę, poproś agenta o zapis pliku poza katalogiem sesji: Copilot CLI 1.0.103 uruchamia proste komendy w rodzaju `ls` czy `date` bez pytania.
