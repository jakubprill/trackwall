# Trackwall

Desktopowa aplikacja open source dla jednej osoby pracującej z wieloma repozytoriami (Java BFF, mikroserwisy, frontendy TS) i wieloma agentami CLI naraz: połączenia między repo, lokalne stawianie serwisów, analiza błędów cross-repo.

Dokumentacja:

- [Architektura](docs/architecture.md)
- [Zasady dla agentów i Definition of done](AGENTS.md)
- [Słownik pojęć](CONTEXT.md)
- [Spike'i etapu 1](spikes/README.md)
- [Wydania i instalacja](docs/release.md)

## Stan

Etap 1 (szkielet): daemon z `/api/health`, UI z panelem daemona, powłoka Tauri z trayem, portable build na Windows i macOS, CI na Linuksie, Windowsie i macOS przy każdym PR (ADR-22), spike'i Job Objects i PTY.

Nawigacja: widoki przełącza pasek przy lewej krawędzi okna, jak w VS Code: Repo (Ctrl+1) u góry, Daemon (Ctrl+9) i Ustawienia (Ctrl+,) na dole; na macOS ⌘ zamiast Ctrl. Nazwę i skrót widoku pokazuje podpowiedź po najechaniu na ikonę.

Przeglądanie repo: w widoku „Ustawienia” wskazujesz folder z projektami (pełną ścieżką), a widok „Repo” pokazuje każde repo gita, które leży bezpośrednio w nim: gałąź, liczbę zmian i ahead/behind, README, pliki i commity z ostatniego commita, oraz otwiera repo w VS Code. Repo sklonowane do folderu pojawia się na liście samo. Przycisk „+” na liście repo otwiera wyszukiwarkę repo z GitLab i GitHub (hostingi dodaje się w „Ustawieniach”) i klonuje wybrane jednym kliknięciem; wymaga zalogowanego `glab` (`glab auth login --hostname <host>`) albo `gh` (`gh auth login`) w `PATH`, a Trackwall nie przechowuje tokenu. Przycisk „Synchronizuj wszystko” pobiera zmiany każdego repo (`git fetch`) i przesuwa gałąź domyślną do zdalnej, gdy to czysty fast-forward; repo ze zmianami w gałęzi domyślnej albo z rozjechaną gałęzią zostaje nietknięte, a panel synchronizacji w miejscu karty repo mówi dlaczego. Ścieżka folderu jest kluczem `projectsDir`, a hostingi kluczem `repoHosts` w `~/.trackwall/workspace.yaml`; oba można ustawić też ręcznie. Wymaga `git` w `PATH`.

Taski mise: zakładka „Taski mise” w karcie repo pokazuje taski z `mise tasks ls`, uruchamia je (`mise run <task>` w korzeniu repo) i zatrzymuje jako całą grupę procesów, razem z ich potomkami (Job Object na Windowsie, sesja POSIX na macOS, ADR-20); po błędzie pokazuje kod wyjścia i ostatnie linie wyjścia. Przycisk „Log” przy tasku pokazuje jego wyjście na żywo (stdout i stderr, bez kolorów ANSI, błędy i ostrzeżenia wyróżnione), a uruchomienie otwiera log samo; wartości zmiennych środowiskowych o nazwach sekretów (`*_TOKEN`, `*_PASSWORD`, `*_SECRET`…) są w logu zamienione na `***`. Pełny log każdego taska leży w `~/.trackwall/logs/mise-task/<repo>/<task>.jsonl` (najwyżej 10 MB plus jeden poprzedni plik `.1.jsonl`). Konfiguracji mise, której mise nie ufa, można zaufać przyciskiem (`mise trust`). Wyjście daemona zatrzymuje wszystkie taski, a grupy po awarii daemona sprząta jego następny start. Wymaga `mise` w `PATH` (na macOS wystarczy `PATH` z powłoki logowania).

Etap 2 (prototyp): wykrywanie stanu sesji Copilot CLI z hooków i sekwencji terminala (ADR-17), na razie jako skrypt nagrywający sesję, jeszcze bez widoku Zadania; opis niżej w „Nagrywanie sesji Copilot CLI”.

## Układ repo

| Ścieżka | Co to jest |
|---|---|
| `packages/protocol` | typy i schematy zod wspólne dla daemona, UI i CLI |
| `packages/daemon` | daemon (Bun, kod zgodny z Node), budowany do jednej binarki |
| `packages/ui` | React + Tailwind + shadcn/ui, Vite |
| `apps/desktop` | powłoka Tauri 2: okno (półprzezroczyste, ADR-11), tray, start i zatrzymanie daemona |
| `spikes/` | eksperymenty etapu 1, nie trafiają do aplikacji |

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

Prototyp wykrywania stanu zadania (ADR-17). Skrypt uruchamia Copilot CLI w PTY tak jak zrobi to daemon, pokazuje go w bieżącym terminalu, nagrywa i liczy stan (`Working`, `Input`, `Approval`…). Wymaga Bun i zainstalowanego, zalogowanego `copilot` w `PATH` (na Windowsie zarówno `copilot.exe`, jak i `copilot.cmd` z `npm install -g`). Uruchom go w katalogu repo, w którym ma pracować agent, z `bun --no-env-file`, żeby Bun nie wczytał `.env` repo do środowiska Copilot CLI (Bun nadal czyta `bunfig.toml` z bieżącego katalogu, więc w repo z `bunfig.toml` uruchom skrypt z `--config` wskazującym inny plik):

```sh
bun --no-env-file <trackwall>/packages/daemon/scripts/copilot-record.ts record                         # zwykła sesja interaktywna
bun --no-env-file <trackwall>/packages/daemon/scripts/copilot-record.ts record -- -i "Opisz to repo"   # argumenty po -- idą do copilot
bun <trackwall>/packages/daemon/scripts/copilot-record.ts replay <katalog>/session.cast                # stan policzony jeszcze raz z nagrania
```

Po wyjściu z Copilot CLI skrypt drukuje listę zmian stanu i katalog nagrania (domyślnie `~/.trackwall/recordings/<czas>` albo `$TRACKWALL_HOME/recordings/<czas>`, inny przez `--out`): `session.cast` (asciicast v2, do odtworzenia w asciinema), `states.jsonl`, `hooks.jsonl` i `plugin/` z hookami podanymi przez `--plugin-dir`. Stany na żywo widać w drugim terminalu: `tail -f <katalog>/states.jsonl` albo w PowerShell `Get-Content -Wait <katalog>\states.jsonl`. Nagranie zawiera wszystko, co było na ekranie, więc przed dodaniem go do repo jako fixture trzeba je zanonimizować; wpisywane klawisze i treść promptów oraz narzędzi z hooków nie są zapisywane.

## Licencja i bezpieczeństwo

Kod jest na licencji MIT (`LICENSE`). Podatności zgłaszaj prywatnie według `SECURITY.md`.
