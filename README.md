# Trackwall

Desktopowa aplikacja open source dla jednej osoby pracującej z wieloma repozytoriami (Java BFF, mikroserwisy, frontendy TS) i wieloma agentami CLI naraz: połączenia między repo, lokalne stawianie serwisów, analiza błędów cross-repo.

Dokumentacja:

- [Architektura](docs/architecture.md)
- [Zasady dla agentów i Definition of done](AGENTS.md)
- [Słownik pojęć](CONTEXT.md)
- [Spike'i etapu 1](spikes/README.md)
- [Wydania i instalacja](docs/release.md)

## Stan

Etap 1 (szkielet): daemon z `/api/health`, UI z panelem daemona, powłoka Tauri z trayem, portable build na Windows i macOS, CI na Linuksie przy PR i z macierzą Windows + macOS na `main` i ręcznie (ADR-15), spike'i Job Objects i PTY.

Nawigacja: widoki przełącza pasek przy lewej krawędzi okna, jak w VS Code: Repo (Ctrl+1) u góry, Daemon (Ctrl+9) i Ustawienia (Ctrl+,) na dole; na macOS ⌘ zamiast Ctrl. Nazwę i skrót widoku pokazuje podpowiedź po najechaniu na ikonę.

Przeglądanie repo: w widoku „Ustawienia” wskazujesz folder z projektami (pełną ścieżką), a widok „Repo” pokazuje każde repo gita, które leży bezpośrednio w nim: gałąź, liczbę zmian i ahead/behind, README, pliki i commity z ostatniego commita, oraz otwiera repo w VS Code. Repo sklonowane do folderu pojawia się na liście samo. Przycisk „+” na liście repo otwiera wyszukiwarkę repo z GitLab i GitHub (hostingi dodaje się w „Ustawieniach”) i klonuje wybrane jednym kliknięciem; wymaga zalogowanego `glab` (`glab auth login --hostname <host>`) albo `gh` (`gh auth login`) w `PATH`, a Trackwall nie przechowuje tokenu. Przycisk „Synchronizuj wszystko” pobiera zmiany każdego repo (`git fetch`) i przesuwa gałąź domyślną do zdalnej, gdy to czysty fast-forward; repo ze zmianami w gałęzi domyślnej albo z rozjechaną gałęzią zostaje nietknięte, a panel synchronizacji w miejscu karty repo mówi dlaczego. Ścieżka folderu jest kluczem `projectsDir`, a hostingi kluczem `repoHosts` w `~/.trackwall/workspace.yaml`; oba można ustawić też ręcznie. Wymaga `git` w `PATH`.

Taski mise: zakładka „Taski mise” w karcie repo pokazuje taski z `mise tasks ls`, uruchamia je (`mise run <task>` w korzeniu repo) i zatrzymuje jako całą grupę procesów, razem z ich potomkami (Job Object na Windowsie, sesja POSIX na macOS, ADR-20); po błędzie pokazuje kod wyjścia i ostatnie linie wyjścia. Konfiguracji mise, której mise nie ufa, można zaufać przyciskiem (`mise trust`). Wyjście daemona zatrzymuje wszystkie taski, a grupy po awarii daemona sprząta jego następny start. Wymaga `mise` w `PATH` (na macOS wystarczy `PATH` z powłoki logowania).

Serwer MCP dla Copilot CLI: daemon wystawia serwer MCP tylko do odczytu (ADR-22) z narzędziami `list_repos` (repo z folderu z projektami: ścieżka, adres repo zdalnego, gałąź, stan, wynik ostatniej synchronizacji) i `get_repo` (README, ostatnie commity, taski mise jednego repo). Copilot CLI podłącza się raz, komendą z widoku „Daemon” (opis niżej w „Podłączenie Copilot CLI”).

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

Przebieg CI na Windowsie i macOS (push na `main` albo ręczne uruchomienie) publikuje oba archiwa jako artefakty.

## Podłączenie Copilot CLI

Copilot CLI uruchamia most stdio daemona (`trackwall-daemon mcp-stdio`) jako lokalny serwer MCP; most znajduje działający daemon przez `daemon.json`, więc konfiguracja nie zmienia się po restarcie daemona i nie zawiera tokenu. Gotową komendę dla tej instalacji pokazuje widok „Daemon” (Ctrl+9, przycisk kopiowania). Wygląda tak:

```sh
copilot mcp add trackwall -- /Applications/Trackwall.app/Contents/MacOS/trackwall-daemon mcp-stdio                     # macOS
copilot mcp add trackwall '--' '<katalog z Trackwall>\trackwall-daemon.exe' mcp-stdio    # Windows (PowerShell; `--` w apostrofach)
copilot mcp add trackwall -- bun --no-env-file --config=<trackwall>/packages/daemon/bunfig.toml <trackwall>/packages/daemon/src/main.ts mcp-stdio --home <katalog stanu>   # ze źródeł
```

Komenda dopisuje wpis `trackwall` do `~/.copilot/mcp-config.json` (na Windowsie `%USERPROFILE%\.copilot\mcp-config.json`; ten sam wpis w JSON jest w widoku „Daemon”, gdyby trzeba go wkleić ręcznie). Trackwall musi działać, zanim wystartuje Copilot CLI, bo Copilot uruchamia serwery MCP przy starcie sesji; `/mcp` w Copilot CLI pokazuje, czy serwer `trackwall` jest połączony. Potem wystarczy poprosić agenta np. „Jakie repo mam w folderze z projektami?”.

Sprawdzenie ręczne (wymaga zalogowanego Copilot CLI): uruchom Trackwall z ustawionym folderem z projektami, wykonaj komendę z widoku „Daemon”, uruchom `copilot` w folderze z projektami, sprawdź w `/mcp`, że `trackwall` jest połączony z narzędziami `list_repos` i `get_repo`, poproś o listę repo, a potem o szczegóły jednego z nich (README, taski mise). Log daemona (terminal `pnpm dev` albo `trackwall-daemon`) pokazuje każde wywołanie jako `[mcp] list_repos: ok w … ms`.

Inne klienty MCP mogą też rozmawiać z daemonem wprost przez Streamable HTTP pod `http://127.0.0.1:<port>/mcp` z nagłówkiem `Authorization: Bearer <token>`; port i token są w `daemon.json` i zmieniają się przy każdym starcie daemona.

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
