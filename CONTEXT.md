# Słownik Trackwall

Pojęcia, które łatwo pomylić. Kod, UI, narzędzia MCP i dokumentacja używają tych słów i tylko tych: w prozie polskiego słowa, w kodzie identyfikatora podanego przy haśle. Szczegóły są w `docs/architecture.md`; tu jest tylko to, co trzeba wiedzieć, żeby nazwać rzecz poprawnie. Nowe pojęcie dopisuje się w tym samym PR, w którym się pojawia.

## Aplikacja

**Daemon** (`daemon`):
Proces `trackwall-daemon`, który trzyma cały stan i całą logikę. Jedyne źródło prawdy; UI, CLI `ws` i agenci (przez serwer MCP w daemonie) są klientami jego fasady.
_Unikaj_: backend, serwer (bez dopowiedzenia)

**Powłoka** (`apps/desktop`):
Aplikacja Tauri: okno, tray, uruchamianie i nadzór daemona jako sidecara, sprawdzenie WebView2. Nie zawiera logiki domenowej.
_Unikaj_: aplikacja (gdy chodzi tylko o Tauri)

**Fasada** (`Facade`):
Zbiór interfejsów modułów daemona przekazywany do transportów (HTTP, MCP, zdarzenia). Moduły rozmawiają ze sobą tylko przez nią.

**Moduł**:
Wydzielona część daemona z §4 architektury (`procs`, `logs`, `workspace`…), z jawnym interfejsem i listą zależności. §4 nazywa jego interfejs „klasą serwisu”; w kodzie nie dawaj jej sufiksu `Service`, bo to słowo należy do serwisu z workspace.
_Unikaj_: serwis (to byt z workspace, patrz niżej), paczka

**Paczka**:
Pakiet pnpm z `pnpm-workspace.yaml` (`@trackwall/daemon`, `@trackwall/protocol`, spike'i…).
_Unikaj_: workspace (to osobne pojęcie, patrz niżej)

**`ws`**:
Cienki klient CLI daemona przez HTTP na loopbacku. Nie ma nic wspólnego z WebSocketem `/ws`.

**Token daemona**:
Sekret z `~/.trackwall/daemon.json`, którym UI, `ws` i powłoka uwierzytelniają się w API.

**Token zadania**:
Osobny token dla sesji zadania; po nim daemon wie, które zadanie woła MCP, i ogranicza jego narzędzia (§8).

## Workspace i wiedza

**Workspace** (`workspace`):
Zbiór repo użytkownika (repo z folderu z projektami) i jego konfiguracja w `workspace.yaml`, poza repozytorium Trackwall. Tu żyje wszystko, co firmowe.
_Unikaj_: projekt

**Folder z projektami** (`projectsDir`):
Jeden katalog na dysku użytkownika, wskazany w `workspace.yaml` albo w ustawieniach. Każdy jego bezpośredni podkatalog z `.git` to repo z workspace (ADR-18); repo dodaje się, klonując je do tego folderu.
_Unikaj_: katalog workspace, root, folder (bez dopowiedzenia)

**Repo** (`Repo`, `RepoId`):
Jedno repozytorium z workspace, identyfikowane slugiem z nazwy jego katalogu.

**Stan repo** (`RepoStatus`):
Gałąź, ostatni commit, liczba zmian w katalogu roboczym i ahead/behind względem gałęzi śledzonej, odczytane z gita przy każdym zapytaniu (`ok`), albo `unavailable` z komunikatem, gdy git go nie czyta (repo, którego katalog zniknął, znika z listy). Nigdy nie jest zapisywany.
_Unikaj_: status (w polskim tekście), sync (to osobna akcja)

**Przegląd repo** (`RepoOverview`):
README i ostatnie commity repo w jednej odpowiedzi; stan repo przychodzi z listy repo. Pliki przeglądane są osobno, zawsze z commita HEAD (ADR-14).

**Worktree**:
Osobny katalog roboczy gita dla zadania, w `<repo>/.worktrees/<zadanie>`. Usuwany dopiero po potwierdzonym zatrzymaniu procesów, które z niego korzystają.

**Karta** (karta repo, `RepoCard`):
Fakty o repo wyciągnięte deterministycznie z plików buildu i konfiguracji: co repo udostępnia (`provides`), czego używa (`consumes`) i czego potrzebuje do działania (`runtime`). LLM dopisuje tylko opis i propozycje połączeń oznaczone `origin: 'llm'` (ADR-6).
_Unikaj_: profil, metadane

**Ekstraktor**:
Wtyczka per stack (`extractors/spring`, `extractors/node`), która czyta pliki repo i zwraca fakty z pozycją w pliku.

**Graf**:
Złączenie kart: węzły to serwisy, krawędzie łączą `consumes` jednego z `provides` drugiego.

**Krawędź** (`Edge`):
Połączenie w grafie z rodzajem (`http`, `topic`, `package`, `env-url`), kluczem, pewnością i dowodami.

**Dowód** (`Evidence`):
Plik i linia, z których wynika fakt na karcie lub krawędź w grafie.

**Pewność** (`confidence`):
`exact`, `high`, `medium` albo `low`. Przy `low` daemon niczego nie robi automatycznie.

## Procesy i serwisy

**Serwis** (`Service`, `ServiceId`):
Repo plus jego task mise `dev`, port i sonda zdrowia. Jedno repo może mieć kilka serwisów.
_Unikaj_: aplikacja, mikroserwis (gdy chodzi o byt w Trackwall)

**Stan serwisu**:
`stopped`, `starting`, `healthy`, `unhealthy`, `stopping` albo `crashed`; zawsze zaobserwowany, nigdy założony.

**Grupa procesów** (`ProcessGroup`):
Proces-lider i wszyscy jego potomkowie, zatrzymywani razem: Job Object na Windowsie, nowa sesja POSIX (`setsid`) z zabijaniem po `-pgid` na macOS.
_Unikaj_: drzewo procesów (gdy chodzi o jednostkę zarządzaną)

**Sonda** (health):
Task mise `health` uruchamiany cyklicznie; jego wynik decyduje o `healthy` / `unhealthy`.

**Dzierżawa** (`Lease`):
Informacja, która gałąź albo worktree zajmuje serwis na jego porcie. Domyślnie repo główne; zadanie może ją przejąć i oddać.
_Unikaj_: lock, rezerwacja

**Sierota**:
Grupa procesów z `runtime.json`, której daemon już nie nadzoruje (np. po awarii). Sprzątana przy starcie daemona tylko, gdy lider to ten sam proces (ten sam czas startu) albo już nie żyje, a grupa tak.

## Agenci

**Zadanie** (`Task`, `TaskId`):
Praca jednego agenta nad jednym repo: prompt, worktree, gałąź, sesja, budżet, dzierżawy i podsumowanie. W kodzie i API `task` znaczy zawsze zadanie.
_Unikaj_: job; „task” w polskim tekście (myli się z taskiem mise)

**Task mise**:
Nazwana komenda z `mise.toml` repo: `setup`, `dev`, `test`, `build`, `lint`, `health`. W kodzie zawsze z dopowiedzeniem (`miseTask`, `mise.run(...)`), nigdy gołe `task`. Jedyny wyjątek to argument `task` narzędzia MCP `run_task` (§5.3), gdzie kontekst jest jednoznaczny.

**Uruchomienie** (`run`, `runId`, stan: `RunState`):
Jednorazowe wykonanie taska mise przez `run_task` albo z UI, z własną grupą procesów i logami. Stan `running`, `stopping` albo `exited` (kod wyjścia, sygnał, czy zatrzymał je użytkownik, ostatnie linie wyjścia), zawsze zaobserwowany. Nie jest zadaniem ani serwisem.

**Zaufanie mise** (`mise trust`, akcja `trust`):
Zgoda użytkownika, żeby mise czytał konfigurację repo, która może uruchamiać programy (`[env]`, szablony, hooki). Bez niej mise nie poda listy tasków (`untrusted`). Daje się tylko w UI.
_Unikaj_: autoryzacja, akceptacja

**Adapter**:
Wszystko, co Trackwall wie o jednym CLI agenta: szablon komendy, konfiguracja MCP, wznowienie, detektory stanu. Jedyny adapter to Copilot CLI (ADR-8).

**Sesja** (sesja zadania):
CLI agenta działające w PTY należącym do daemona, nagrywane do `sessions/<zadanie>.cast`.
_Unikaj_: sesja POSIX (to pojęcie z grupy procesów)

**Stan zadania** (`TaskState`, zmiana: `TaskStateChange`):
`Working`, `Input`, `Approval`, `Plan`, `Done`, `Error` albo `Stale`, zawsze ze źródłem (`hook`, `osc`, `screen`, `timeout`, `exit`) i pewnością (§4.4).

**Detektor stanu**:
Reguła, która z hooków, sekwencji terminala albo wyglądu ekranu wnioskuje stan zadania.

**Wtyczka sesji** (`writeCopilotPlugin`):
Katalog z `plugin.json` i `hooks.json`, który daemon podaje Copilot CLI przez `--plugin-dir`, żeby hooki zgłaszały stan tylko tej jednej sesji (ADR-17).
_Unikaj_: plugin (w polskim tekście), konfiguracja hooków

**Rekord hooka** (`CopilotHookRecord`):
Jedno wywołanie hooka z wtyczki sesji: zdarzenie, czas odebrania i tylko pola payloadu potrzebne do stanu, a o reszcie same nazwy (bez promptu, argumentów i wyników narzędzi). Linia `hooks.jsonl` i znacznik w nagraniu.
_Unikaj_: rekord (bez dopowiedzenia; to linia logu)

**Tytuł okna** (`windowTitle`):
Tytuł, który CLI agenta ustawia sekwencją OSC 0 / 2; w Copilot CLI to opis bieżącej pracy. Pokazywany obok stanu, nigdy nie jest stanem.
_Unikaj_: intencja, intent

**Nagranie** (nagranie sesji, `session.cast`):
Wyjście sesji w formacie asciicast v2 ze znacznikami rekordów hooków i kodu wyjścia, z którego da się policzyć stan jeszcze raz (`replayCopilotRecording`). Bez wejścia z klawiatury.

**Budżet**:
Limit czasu i liczby commitów zadania; po przekroczeniu daemon kończy sesję.

**Podsumowanie**:
Blok, którym agent kończy zadanie; trafia do pola `summary` i do propozycji PR. Trackwall niczego sam nie scala (ADR-9).

## Logi, zdarzenia i audyt

**Rekord** (`LogRecord`):
Jedna linia wyjścia procesu po parsowaniu: `seq`, czas, źródło, poziom, treść, opcjonalnie identyfikator śladu (`traceId` w TypeScript, `trace_id` w narzędziach MCP).
_Unikaj_: wpis, event

**Źródło** (`LogSource`):
Skąd pochodzi rekord: serwis, zadanie albo sam daemon, z identyfikatorem.

**`seq`**:
Globalny, rosnący numer rekordu dla wszystkich źródeł. Kursor `since_seq` działa dla jednego serwisu i dla całego workspace.

**Zdarzenie**:
Wiadomość daemona na WebSocket `/ws` (`service.state`, `task.state`…) z własnym `seq` zdarzeń.
_Unikaj_: rekord (to log)

**Snapshot**:
Pełny stan z `GET /api/snapshot`, od którego UI zaczyna i do którego wraca po `resync`.

**Maskowanie**:
Zamiana wartości sekretów na `***` przed zapisem rekordu do bufora.

**Audyt** (`AuditEntry`):
Zapis każdego wywołania narzędzia MCP: klient, narzędzie, argumenty, czas, skrót wyniku. Widoczny tylko w UI.

## Sekrety

**Repo sekretów**:
Repozytorium z manifestami k8s `Secret`, po jednej gałęzi `origin/<repo>` na repo z workspace (ADR-10). Klonowane poza workspace.

**Sekret**:
Klucz z `data` albo `stringData` manifestu, wstrzykiwany jako zmienna środowiskowa o tej samej nazwie. Sesja zadania widzi tylko, czy jest ustawiony.

## Scena 3D

**Scena** (`@trackwall/scene`):
Dashboard 3D na Pawn, zasilany tymi samymi zdarzeniami co reszta UI.

**Warstwa**:
Poziom węzła w scenie (FE → BFF → serwisy → bazy), liczony z grafu jako najdłuższa ścieżka od węzłów bez wejść.
