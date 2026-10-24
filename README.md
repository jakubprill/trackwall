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

Nawigacja: widoki przełącza pasek przy lewej krawędzi okna, jak w VS Code: Repo (Ctrl+1), Sesje (Ctrl+2) i Przegląd (Ctrl+3) u góry, Daemon (Ctrl+9) i Ustawienia (Ctrl+,) na dole; na macOS ⌘ zamiast Ctrl. Nazwę i skrót widoku pokazuje podpowiedź po najechaniu na ikonę.

Przeglądanie repo: w widoku „Ustawienia” wskazujesz folder z projektami (pełną ścieżką), a widok „Repo” pokazuje każde repo gita, które leży bezpośrednio w nim: gałąź, liczbę zmian i ahead/behind, README, pliki i commity z ostatniego commita, oraz otwiera repo w VS Code. Repo sklonowane do folderu pojawia się na liście samo. Przycisk „+” na liście repo otwiera wyszukiwarkę repo z GitLab i GitHub (hostingi dodaje się w „Ustawieniach”) i klonuje wybrane jednym kliknięciem; wymaga zalogowanego `glab` (`glab auth login --hostname <host>`) albo `gh` (`gh auth login`) w `PATH`, a Trackwall nie przechowuje tokenu. Przycisk „Synchronizuj wszystko” pobiera zmiany każdego repo (`git fetch`) i przesuwa gałąź domyślną do zdalnej, gdy to czysty fast-forward; repo ze zmianami w gałęzi domyślnej albo z rozjechaną gałęzią zostaje nietknięte, a panel synchronizacji w miejscu szczegółów repo mówi dlaczego. Ścieżka folderu jest kluczem `projectsDir`, a hostingi kluczem `repoHosts` w `~/.trackwall/workspace.yaml`; oba można ustawić też ręcznie. Wymaga `git` w `PATH`.

Taski mise: zakładka „Taski mise” w szczegółach repo pokazuje taski z `mise tasks ls`, uruchamia je (`mise run <task>` w korzeniu repo) i zatrzymuje jako całą grupę procesów, razem z ich potomkami (Job Object na Windowsie, sesja POSIX na macOS, ADR-20); po błędzie pokazuje kod wyjścia i ostatnie linie wyjścia. Przycisk „Log” przy tasku pokazuje jego wyjście na żywo (stdout i stderr, bez kolorów ANSI, błędy i ostrzeżenia wyróżnione), a uruchomienie otwiera log samo; wartości zmiennych środowiskowych o nazwach sekretów (`*_TOKEN`, `*_PASSWORD`, `*_SECRET`…) są w logu zamienione na `***`. Pełny log każdego taska leży w `~/.trackwall/logs/mise-task/<repo>/<task>.jsonl` (najwyżej 10 MB plus jeden poprzedni plik `.1.jsonl`); w nazwie pliku znaki spoza małych liter, cyfr, `_` i `-` są zakodowane jako `%XX`, np. task `build:ui` to `build%3Aui.jsonl`. Konfiguracji mise, której mise nie ufa, można zaufać przyciskiem (`mise trust`). Wyjście daemona zatrzymuje wszystkie taski, a grupy po awarii daemona sprząta jego następny start. Wymaga `mise` w `PATH` (na macOS wystarczy `PATH` z powłoki logowania).

Karta repo i tagi: zakładka „Karta” w szczegółach repo pokazuje fakty wyczytane z plików buildu i konfiguracji w ostatnim commicie (ADR-25): paczki Maven, Gradle i npm, które repo udostępnia i których używa, wymagane narzędzia (mise, `.tool-versions`, `.nvmrc`, wrappery), mechanizmy (Spring Boot, Feign, Kafka, Helm, React…), aplikacje Spring Boot z portem, endpointy HTTP z kontrolerów, klienci HTTP (Feign, `@HttpExchange`, WebClient, RestClient, RestTemplate, adresy z `application*.yml` w każdym profilu, `.env` i proxy frontendu; ADR-30) i pliki buildu, każdy fakt z plikiem i linią. Niczego nie buduje ani nie uruchamia; karta liczy się raz na commit i leży w `~/.trackwall/cards`. Z karty powstają tagi repo (`java`, `typescript`, `frontend`, `backend`, `bff`, `library`, `monorepo`), widoczne na liście repo z powodem w podpowiedzi; filtr nad listą zawęża ją do repo z każdym wybranym tagiem. Własne tagi nadaje klucz `repoTags` w `~/.trackwall/workspace.yaml` (na razie tylko ręcznie): tag i wzorce identyfikatora albo adresu repo zdalnego, np. `repoTags: { core-api: ["*-core"] }`.

Graf połączeń: widok „Przegląd” (Ctrl+3) rysuje repo z folderu jako graf (ADR-29): linia prowadzi od repo, które używa paczki, do repo, które ją buduje (współrzędne Maven, także z Gradle, i nazwy npm z kart), i od repo, którego klient HTTP woła aplikację albo endpointy innego repo (po nazwie aplikacji, hoście, porcie na `localhost` albo ścieżkach; ADR-30), od frontendów po lewej do bibliotek po prawej. Każde połączenie ma pewność: pewne, prawie pewne, prawdopodobne albo możliwe. Kliknięcie repo pokazuje w panelu po prawej, kogo używa i kto używa jego, z dowodami (plik i linia). Połączenia, których karty nie widzą, dopisuje się ręcznie pod kluczem `graph` w `~/.trackwall/workspace.yaml`: `packages` przypisuje paczkę do repo (`com.example:orders-client: orders-api`), `apps` nazwę aplikacji albo host adresu do repo (`orders.internal.example.com: orders-api`), a `edges` dodaje krawędź z opisem (`- { from: shop-web, to: orders-bff, note: HTTP /api/orders }`); repo wskazuje identyfikator albo adres `host/ścieżka`.

Serwer MCP dla Copilot CLI: daemon wystawia serwer MCP tylko do odczytu (ADR-24) z narzędziami `list_repos` (repo z folderu z projektami: ścieżka, adres repo zdalnego, gałąź, stan, wynik ostatniej synchronizacji i tagi; z argumentem `tags` tylko repo z tymi tagami), `get_repo` (README, ostatnie commity, taski mise i tagi jednego repo), `get_repo_card` (karta repo z tagami i dowodami), `tail` (log taska mise od kursora, z sekretami zamienionymi na `***`), `who_calls` (kto używa danego repo, przez paczki i HTTP, z dowodami), `subgraph_for` (fragment grafu połączeń wokół repo) i `find_endpoint` (endpoint HTTP po ścieżce albo nazwie, z repo, które go wołają). Copilot CLI podłącza się raz, komendą z widoku „Daemon” (opis niżej w „Podłączenie Copilot CLI”).

Komenda zbiorcza: przycisk „Komenda zbiorcza” pod listą repo otwiera panel, w którym wybiera się repo (domyślnie wszystkie widoczne po filtrze tagów) i kroki: synchronizacja, narzędzia (`mise install`), zależności (task mise `setup`) i build (task mise `build`). Kroki idą w repo po kolei, a repo po trzy naraz; panel pokazuje wynik każdego kroku w każdym repo, a przy błędzie kod wyjścia i ostatnie linie. Repo bez taska ma krok pominięty, błąd kończy tylko to repo, a „Przerwij” zatrzymuje trwające taski (także uruchomiony wcześniej ze szczegółów repo, do którego komenda dołączyła) i nie zaczyna kolejnych. Powtórka jest szybka, gdy taski mają w `mise.toml` `sources` i `outputs` (ADR-27).

Sesje Copilot CLI: widok „Sesje” uruchamia Copilot CLI w wybranym repo z folderu z projektami, z podłączonym serwerem MCP Trackwall, kilka sesji naraz, każdą w terminalu należącym do daemona (ADR-26), więc sesja działa dalej po zamknięciu okna. Lista pokazuje stan każdej sesji z hooków Copilot CLI (pracuje, czeka na Ciebie, prosi o zgodę; ADR-17) i nad czym agent pracuje, przycisk „Następna czekająca” przełącza na sesję, która czeka na odpowiedź, a pasek widoków pokazuje, ile sesji czeka. Gdy sesja kończy pracę i czeka, okno miga na pasku zadań (na macOS ikona podskakuje w Docku), a menu traya ma pozycję „Czeka: <repo>”, która otwiera tę sesję. „Zatrzymaj” kończy całą grupę procesów sesji, „Zamknij” usuwa zakończoną sesję z listy. Copilot CLI przejmuje mysz w terminalu, więc tekst zaznacza się przeciągnięciem z wciśniętym Option (macOS) albo Shift (Windows) i kopiuje Cmd+C albo Ctrl+C (Ctrl+C bez zaznaczenia przerywa pracę agenta). Wymaga Copilot CLI w `PATH` (`copilot`; na Windowsie z `npm install -g` Trackwall uruchamia `copilot.exe` z paczki zamiast `copilot.cmd`) i daemona pod Bun (wydanie albo `pnpm dev`); pod Node sesji nie ma. Sesje nie przeżywają wyjścia daemona i nie są nagrywane; nagrania robi skrypt opisany niżej w „Nagrywanie sesji Copilot CLI”.

Zadania agenta: przycisk „+” w widoku „Sesje” otwiera formularz nowego zadania: repo i polecenie dla agenta. Trackwall tworzy nową gałąź `trackwall/<skrót polecenia>` od gałęzi domyślnej repo w osobnym worktree w `~/.trackwall/worktrees/<repo>/` i uruchamia w nim Copilot CLI z poleceniem jako pierwszą wiadomością (ADR-31), więc kilka zadań w jednym repo działa naraz bez kolizji, a Twój katalog roboczy zostaje nietknięty. Zakładka „Zmiany” pokazuje na żywo pliki i diff worktree względem gałęzi domyślnej, z commitami zadania i tym, czego agent jeszcze nie zacommitował. Przyciski: „VS Code” otwiera worktree, „Wznów” uruchamia Copilot CLI z rozmową zadania (`--resume`), a „Zakończ zadanie” usuwa worktree i zostawia gałąź albo usuwa obie; zmiany, które by przy tym przepadły, Trackwall usuwa dopiero po potwierdzeniu. Zadania przeżywają restart daemona. Copilot CLI pyta o zaufanie w każdym nowym folderze; żeby nie pytał przy każdym zadaniu, dopisz katalog `worktrees` (pełną ścieżkę podaje formularz) do `trustedFolders` w `~/.copilot/config.json`.

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

## Podłączenie Copilot CLI

Copilot CLI uruchamia most stdio daemona (`trackwall-daemon mcp-stdio`) jako lokalny serwer MCP; most znajduje działający daemon przez `daemon.json`, więc konfiguracja nie zmienia się po restarcie daemona i nie zawiera tokenu. Gotową komendę dla tej instalacji pokazuje widok „Daemon” (Ctrl+9, przycisk kopiowania). Wygląda tak:

```sh
copilot mcp add trackwall -- /Applications/Trackwall.app/Contents/MacOS/trackwall-daemon mcp-stdio                     # macOS
copilot mcp add trackwall '--' '<katalog z Trackwall>\trackwall-daemon.exe' mcp-stdio    # Windows (PowerShell; `--` w apostrofach)
copilot mcp add trackwall -- bun --no-env-file --config=<trackwall>/packages/daemon/bunfig.toml <trackwall>/packages/daemon/src/main.ts mcp-stdio --home <katalog stanu>   # ze źródeł
```

Komenda dopisuje wpis `trackwall` do `~/.copilot/mcp-config.json` (na Windowsie `%USERPROFILE%\.copilot\mcp-config.json`; ten sam wpis w JSON jest w widoku „Daemon”, gdyby trzeba go wkleić ręcznie). Trackwall musi działać, zanim wystartuje Copilot CLI, bo Copilot uruchamia serwery MCP przy starcie sesji; `/mcp` w Copilot CLI pokazuje, czy serwer `trackwall` jest połączony. Potem wystarczy poprosić agenta np. „Jakie repo mam w folderze z projektami?”.

Sprawdzenie ręczne (wymaga zalogowanego Copilot CLI): uruchom Trackwall z ustawionym folderem z projektami, wykonaj komendę z widoku „Daemon”, uruchom `copilot` w folderze z projektami, sprawdź w `/mcp`, że `trackwall` jest połączony z narzędziami `list_repos`, `get_repo`, `get_repo_card`, `tail`, `who_calls`, `subgraph_for` i `find_endpoint`, poproś o listę repo, a potem o szczegóły jednego z nich (README, taski mise), o jego kartę (np. „Jakich paczek używa orders-bff?”) i o to, kto go używa („Które repo dotknie zmiana core-lib?”, „Kto woła GET /api/orders/{id}?”). Log daemona (terminal `pnpm dev` albo `trackwall-daemon`) pokazuje każde wywołanie jako `[mcp] list_repos: ok w … ms`.

Inne klienty MCP mogą też rozmawiać z daemonem wprost przez Streamable HTTP pod `http://127.0.0.1:<port>/mcp` z nagłówkiem `Authorization: Bearer <token>`; port i token są w `daemon.json` i zmieniają się przy każdym starcie daemona.

## Ikony

Źródłem ikon są `apps/desktop/assets/icon.svg` (ikona aplikacji) i `apps/desktop/assets/tray-icon.svg` (jednobarwny znak traya). Po zmianie któregoś z nich:

```sh
pnpm --filter @trackwall/desktop icons   # ikony z bundle.icon w tauri.conf.json, szablon traya dla macOS i favicon UI
```

Wygenerowane pliki trafiają do repo razem ze zmienionym SVG. `tauri icon` zapisuje `icon.icns` za każdym razem w innej kolejności wpisów, więc zmieniony `icon.icns` po przebiegu bez zmiany SVG odrzuć (`git checkout -- apps/desktop/src-tauri/icons/icon.icns`).

## Nagrywanie sesji Copilot CLI

Prototyp wykrywania stanu zadania (ADR-17), do zbierania nagrań. Skrypt uruchamia Copilot CLI w PTY tak jak daemon w widoku „Sesje”, pokazuje go w bieżącym terminalu, nagrywa i liczy stan (`Working`, `Input`, `Approval`…). Wymaga Bun i zainstalowanego, zalogowanego `copilot` w `PATH` (na Windowsie zarówno `copilot.exe`, jak i `copilot.cmd` z `npm install -g`). Uruchom go w katalogu repo, w którym ma pracować agent, z `bun --no-env-file`, żeby Bun nie wczytał `.env` repo do środowiska Copilot CLI (Bun nadal czyta `bunfig.toml` z bieżącego katalogu, więc w repo z `bunfig.toml` uruchom skrypt z `--config` wskazującym inny plik):

```sh
bun --no-env-file <trackwall>/packages/daemon/scripts/copilot-record.ts record                         # zwykła sesja interaktywna
bun --no-env-file <trackwall>/packages/daemon/scripts/copilot-record.ts record -- -i "Opisz to repo"   # argumenty po -- idą do copilot
bun <trackwall>/packages/daemon/scripts/copilot-record.ts replay <katalog>/session.cast                # stan policzony jeszcze raz z nagrania
```

Po wyjściu z Copilot CLI skrypt drukuje listę zmian stanu i katalog nagrania (domyślnie `~/.trackwall/recordings/<czas>` albo `$TRACKWALL_HOME/recordings/<czas>`, inny przez `--out`): `session.cast` (asciicast v2, do odtworzenia w asciinema), `states.jsonl`, `hooks.jsonl` i `plugin/` z hookami podanymi przez `--plugin-dir`. Stany na żywo widać w drugim terminalu: `tail -f <katalog>/states.jsonl` albo w PowerShell `Get-Content -Wait <katalog>\states.jsonl`. Nagranie zawiera wszystko, co było na ekranie, więc przed dodaniem go do repo jako fixture trzeba je zanonimizować; wpisywane klawisze, prompty oraz argumenty i wyniki narzędzi z hooków nie są zapisywane, ale tytuł i treść powiadomienia (każde do 200 znaków) tak, a prośba o zgodę zawiera w nich komendę albo pełną ścieżkę, o którą prosi agent. Żeby nagrać prośbę o zgodę, poproś agenta o zapis pliku poza katalogiem sesji: Copilot CLI 1.0.103 uruchamia proste komendy w rodzaju `ls` czy `date` bez pytania.

## Licencja i bezpieczeństwo

Kod jest na licencji MIT (`LICENSE`). Podatności zgłaszaj prywatnie według `SECURITY.md`.
