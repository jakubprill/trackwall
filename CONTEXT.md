# Słownik Trackwall

Pojęcia, które łatwo pomylić. Kod, UI, narzędzia MCP i dokumentacja używają tych słów i tylko tych: w prozie polskiego słowa, w kodzie identyfikatora podanego przy haśle. Szczegóły są w `docs/architecture.md`; tu jest tylko to, co trzeba wiedzieć, żeby nazwać rzecz poprawnie. Nowe pojęcie dopisuje się w tym samym PR, w którym się pojawia.

## Aplikacja

**Daemon** (`daemon`):
Proces `trackwall-daemon`, który trzyma cały stan i całą logikę. Jedyne źródło prawdy; UI, CLI `ws` i agenci (przez serwer MCP w daemonie) są klientami jego fasady.
_Unikaj_: backend, serwer (bez dopowiedzenia)

**Powłoka** (`apps/desktop`):
Aplikacja Tauri: okno, tray, uruchamianie i nadzór daemona jako sidecara, sprawdzenie WebView2. Nie zawiera logiki domenowej.
_Unikaj_: aplikacja (gdy chodzi tylko o Tauri)

**Widok** (`View`):
Ekran aplikacji w UI (Repo, Sesje, Przegląd, Daemon, Ustawienia), przełączany paskiem widoków (`ActivityBar`) przy lewej krawędzi okna albo skrótem.
_Unikaj_: zakładka (dla całego ekranu)

**Zakładka** (`TabBar`):
Przełącznik części treści wewnątrz widoku, np. README, Pliki, Commity i Taski mise w widoku Repo.

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
Sekret z `~/.trackwall/daemon.json`, którym UI, `ws`, powłoka i most stdio uwierzytelniają się w API i serwerze MCP.

**Serwer MCP** (`/mcp`, `createMcpEndpoint`):
Część daemona, przez którą agenci czytają jego stan narzędziami MCP; ten sam port i token co API (§5.3, ADR-24).

**Narzędzie MCP** (`McpTool`, lista `mcpTools` w protocol, np. `list_repos`, `get_repo`, `tail`, `who_calls`):
Jedno wywołanie serwera MCP z nazwą po angielsku, wejściem i wynikiem opisanym schematem z `packages/protocol/src/mcp.ts`; mapowanie na fasadę, bez własnej logiki domenowej.
_Unikaj_: komenda, akcja (to pojęcia z API i CLI)

**Most stdio** (`trackwall-daemon mcp-stdio`, `mcpStdioCommand`):
Proces, który CLI agenta uruchamia jako lokalny serwer MCP; przekazuje wiadomości ze stdin do serwera MCP działającego daemona, z portem i tokenem z `daemon.json`.
_Unikaj_: proxy, cienki klient (bez dopowiedzenia)

**Token zadania**:
Osobny token dla sesji zadania; po nim daemon wie, które zadanie woła MCP, i ogranicza jego narzędzia (§8).

## Workspace i wiedza

**Workspace** (`workspace`):
Zbiór repo użytkownika (repo z folderu z projektami) i jego konfiguracja w `workspace.yaml`, poza repozytorium Trackwall. Tu żyje wszystko, co firmowe.
_Unikaj_: projekt

**Folder z projektami** (`projectsDir`):
Jeden katalog na dysku użytkownika, wskazany w `workspace.yaml` albo w ustawieniach. Każdy jego bezpośredni podkatalog z `.git` to repo z workspace (ADR-18); repo dodaje się, klonując je do tego folderu.
_Unikaj_: katalog workspace, root, folder (bez dopowiedzenia)

**Hosting repo** (`RepoHost`, w `workspace.yaml` `repoHosts`):
GitLab albo GitHub z nazwą hosta (`gitlab.example.com`), z którego Trackwall wyszukuje repo i klonuje je do folderu z projektami przez zalogowane `glab` albo `gh` (ADR-19).
_Unikaj_: remote (to nazwa repo zdalnego w gicie, np. `origin`), serwer, źródło (to pojęcie z logów)

**Repo zdalne** (`RemoteRepo`, pełna nazwa `fullName`):
Repo w hostingu dostępne dla użytkownika, np. `grupa/podgrupa/projekt`. Ostatni segment pełnej nazwy to katalog klonu.

**Klonowanie** (`CloneJob`):
Klon jednego repo zdalnego do folderu z projektami, w tle: `running`, `done` albo `failed` z komunikatem. Trzymane tylko w pamięci daemona.

**Repo** (`Repo`, `RepoId`):
Jedno repozytorium z workspace, identyfikowane slugiem z nazwy jego katalogu.

**Adres repo zdalnego** (`Repo.remote`):
Adres głównego remote (`origin` albo jedynego remote w gicie, `mainRemote`) jako `host/ścieżka`, np. `gitlab.example.com/sklep/api`, bez protokołu i użytkownika. Identyfikuje repo niezależnie od nazwy katalogu (ADR-21).
_Unikaj_: URL repo (URL ma protokół i bywa z tokenem), remote bez dopowiedzenia (to nazwa w gicie, np. `origin`)

**Synchronizacja** (`SyncRun`, wynik repo `SyncRepo`):
Fetch każdego repo z folderu z projektami i fast-forward jego gałęzi domyślnej, w tle, z wynikiem per repo: przesunięte, aktualne, pominięte z powodem (`SyncSkipReason`) albo błąd. Nigdy nie scala ani nie nadpisuje lokalnych zmian (ADR-21). Trzymana tylko w pamięci daemona.
_Unikaj_: pull, aktualizacja (bez dopowiedzenia)

**Komenda zbiorcza** (`BatchRun`, krok `BatchStep`, wynik repo `BatchRepo`):
Wybrane kroki na wybranych repo jednym przyciskiem: synchronizacja (`sync`), narzędzia z konfiguracji mise repo (`tools`, `mise install`), zależności (`setup`, task mise `setup`) i build (`build`, task mise `build`), w repo zawsze w tej kolejności, kilka repo naraz, z wynikiem każdego kroku w każdym repo (ADR-27). Błąd kroku kończy repo, pozostałe idą dalej. Trzymana tylko w pamięci daemona.
_Unikaj_: batch (w polskim tekście), operacja zbiorcza, workflow

**Stan repo** (`RepoStatus`):
Gałąź, ostatni commit, liczba zmian w katalogu roboczym i ahead/behind względem gałęzi śledzonej, odczytane z gita przy każdym zapytaniu (`ok`), albo `unavailable` z komunikatem, gdy git go nie czyta (repo, którego katalog zniknął, znika z listy). Nigdy nie jest zapisywany.
_Unikaj_: status (w polskim tekście), sync (to osobna akcja)

**Przegląd repo** (`RepoOverview`):
README i ostatnie commity repo w jednej odpowiedzi; stan repo przychodzi z listy repo. Pliki przeglądane są osobno, zawsze z commita HEAD (ADR-14).

**Worktree** (worktree zadania, `Task.worktree`):
Osobny katalog roboczy gita dla zadania, na gałęzi zadania, w `worktrees/<repo>/<gałąź bez prefiksu>` w katalogu stanu, poza folderem z projektami (ADR-31). Usuwany tylko na prośbę użytkownika i tylko bez działającej sesji zadania; niezacommitowane zmiany przepadają dopiero po potwierdzeniu.

**Commit bazowy** (`Task.base`):
Commit gałęzi domyślnej, od którego wyszła gałąź zadania. Zmiany zadania (`WorktreeChanges`) to katalog roboczy worktree względem niego: commity zadania i niezacommitowane pliki razem.

**Karta** (karta repo, `RepoCard`):
Fakty o repo wyciągnięte deterministycznie z plików buildu i konfiguracji w commicie HEAD: pliki buildu, co repo udostępnia (`provides`), czego używa (`consumes`), wymagane narzędzia, mechanizmy i problemy, każdy fakt z dowodem. Zależy tylko od commita, więc liczy się raz na commit (ADR-25). LLM dopisze tylko opis i propozycje połączeń oznaczone `origin: 'llm'` (ADR-6). W UI zakładka „Karta” w szczegółach repo.
_Unikaj_: profil, metadane; „karta repo” dla całego panelu szczegółów repo

**Plik buildu** (`BuildFile`):
`pom.xml`, `build.gradle(.kts)` albo `package.json`, który należy do buildu repo: korzeń (bez pliku tego samego rodzaju wyżej) albo moduł lub paczka workspace, którą wymienia inny plik buildu (`memberOf`).

**Paczka** (`ProvidedPackage`, `ConsumedPackage`):
Artefakt Maven (`grupa:artefakt`), wtyczka Gradle albo paczka npm, którą repo udostępnia albo której używa. Paczki z tego samego repo nie są używanymi.

**Wymagane narzędzie** (`ToolRequirement`):
Narzędzie i wersja z konfiguracji mise albo `.tool-versions` (źródło `mise`) lub z pliku, który podaje wersję po swojemu (`.nvmrc`, wrapper Maven, `engines.node`; źródło `hint`).

**Mechanizm** (`Mechanism`, `MechanismId`):
Technologia rozpoznana w repo po paczce albo pliku (Spring Boot, Feign, Kafka, Helm…), ze spisem dowodów. Spis, nie wniosek: mechanizm nie mówi, z kim repo się łączy.

**Ekstraktor**:
Czysta funkcja na migawce commita (`RepoSnapshot`) w `modules/cards/` (`maven.ts`, `gradle.ts`, `npm.ts`, `tools.ts`, `mechanisms.ts`), która zwraca fakty z pozycją w pliku. Niczego nie wykonuje.

**Tag repo** (`RepoTag`):
Krótka nazwa grupy repo (`java`, `frontend`, `bff`, `monorepo`…) z powodem, liczona z karty, identyfikatora i adresu repo zdalnego albo z reguły tagów. Tagi są ortogonalne: filtr z kilkoma tagami pokazuje repo, które mają wszystkie.
_Unikaj_: etykieta, kategoria

**Reguła tagów** (`repoTags` w `workspace.yaml`, `RepoTagRules`):
Tag i wzorce identyfikatora albo adresu repo zdalnego, które go nadają (`core-api: ["*-core"]`). Dla grup, których nie widać w plikach, np. zespołów.

**Graf** (graf połączeń, `RepoGraph`, moduł `graph`):
Repo z folderu z projektami jako węzły (`GraphNode`) i krawędzie między nimi, liczone przy każdym pytaniu z kart i z wpisów `graph` w `workspace.yaml`. Dziś węzłem jest repo; serwisy (kilka na repo) przyjdą z modułem `services`.
_Unikaj_: mapa, diagram zależności

**Krawędź** (`GraphEdge`):
Połączenie od repo, które używa, do repo używanego, z rodzajem (`EdgeKind`: `package` z kart, `manual` z `workspace.yaml`; potem `http`, `topic`), kluczem (nazwa paczki albo opis), pewnością i dowodami. Jedna para repo może mieć kilka krawędzi; widok „Przegląd” rysuje je jedną linią.

**Alias paczki** (`graph.packages` w `workspace.yaml`):
Nazwa paczki i repo, które ją dostarcza, gdy karta tego repo jej nie pokazuje (paczka budowana poza plikami buildu, inna nazwa w repozytorium artefaktów). Działa tylko dla paczki, której nie buduje żadne repo z listy.

**Ręczna krawędź** (`ManualEdge`, `graph.edges` w `workspace.yaml`):
Połączenie wpisane przez użytkownika (`from`, `to`, `note`), np. wywołanie HTTP, którego karty jeszcze nie widzą. Repo wskazuje się identyfikatorem albo adresem repo zdalnego (`RepoRef`).

**Dowód** (`Evidence`, w grafie `EdgeEvidence`):
Plik i linia, z których wynika fakt na karcie lub krawędź w grafie; dowód krawędzi ma też repo (albo `null` dla `workspace.yaml`) i zdanie, co w tym miejscu jest.

**Pewność** (`confidence`, w grafie `EdgeConfidence`):
`exact`, `high`, `medium` albo `low`. Krawędź z paczki budowanej przez jedno repo i ręczna krawędź są `exact`, z aliasu paczki `high`, z paczki budowanej przez kilka repo `medium`. Przy `low` daemon niczego nie robi automatycznie.

**Przegląd** (widok „Przegląd”, `GraphView`, identyfikator widoku `graph`):
Widok z grafem połączeń na całą szerokość i panelem szczegółów wybranego repo (kogo używa, kto używa jego, dowody).
_Unikaj_: dashboard (to scena 3D), przegląd repo (to README i commity jednego repo, `RepoOverview`)

## Procesy i serwisy

**Serwis** (`Service`, `ServiceId`):
Repo plus jego task mise `dev`, port i sonda zdrowia. Jedno repo może mieć kilka serwisów.
_Unikaj_: aplikacja, mikroserwis (gdy chodzi o byt w Trackwall)

**Stan serwisu**:
`stopped`, `starting`, `healthy`, `unhealthy`, `stopping` albo `crashed`; zawsze zaobserwowany, nigdy założony.

**Grupa procesów** (`ProcessGroup`):
Proces-lider i wszyscy jego potomkowie, zatrzymywani razem: Job Object na Windowsie, nowa sesja POSIX (`setsid`) z zabijaniem po `-pgid` na macOS.
_Unikaj_: drzewo procesów (gdy chodzi o jednostkę zarządzaną)

**Właściciel grupy** (`owner`):
Klucz, pod którym `procs` trzyma grupę procesów i jej ostatni stan; nadaje go moduł, który ją uruchomił (dziś task mise w repo). Jeden właściciel ma najwyżej jedną grupę, która nie jest potwierdzona jako pusta.

**Sonda** (health):
Task mise `health` uruchamiany cyklicznie; jego wynik decyduje o `healthy` / `unhealthy`.

**Dzierżawa** (`Lease`):
Informacja, która gałąź albo worktree zajmuje serwis na jego porcie. Domyślnie repo główne; zadanie może ją przejąć i oddać.
_Unikaj_: lock, rezerwacja

**Sierota**:
Grupa procesów z `runtime.json`, której daemon już nie nadzoruje (np. po awarii). Sprzątana przy starcie daemona tylko, gdy lider to ten sam proces (ten sam czas startu) albo już nie żyje, a grupa tak.

## Agenci

**Zadanie** (`Task`, `TaskId`):
Praca jednego agenta nad jednym repo: polecenie, worktree, gałąź `trackwall/<skrót>` od gałęzi domyślnej i sesja; docelowo także budżet, dzierżawy i podsumowanie. Dziś (ADR-31) tworzy je widok Sesje, zapisuje `tasks.json`, a sesję zadania można zatrzymać i wznowić. W kodzie i API `task` znaczy zawsze zadanie.
_Unikaj_: job; „task” w polskim tekście (myli się z taskiem mise)

**Polecenie** (`Task.prompt`):
Treść zadania dla agenta, wpisana w widoku Sesje; Copilot CLI dostaje ją jako pierwszą wiadomość sesji zadania (`--interactive`).
_Unikaj_: prompt (w polskim tekście)

**Task mise**:
Nazwana komenda z `mise.toml` repo: `setup`, `dev`, `test`, `build`, `lint`, `health`. W kodzie zawsze z dopowiedzeniem (`miseTask`, `mise.run(...)`), nigdy gołe `task`. Jedyny wyjątek to argument `task` narzędzia MCP `run_task` (§5.3), gdzie kontekst jest jednoznaczny.

**Uruchomienie** (`run`, `runId`, stan: `RunState`):
Jednorazowe wykonanie taska mise przez `run_task` albo z UI, z własną grupą procesów i logami. Stan `running`, `stopping` albo `exited` (kod wyjścia, sygnał, czy zatrzymał je użytkownik, ostatnie linie wyjścia), zawsze zaobserwowany. Nie jest zadaniem ani serwisem.

**Zaufanie mise** (`mise trust`, akcja `trust`):
Zgoda użytkownika, żeby mise czytał konfigurację repo, która może uruchamiać programy (`[env]`, szablony, hooki). Bez niej mise nie poda listy tasków (`untrusted`). Daje się tylko w UI.
_Unikaj_: autoryzacja, akceptacja

**Adapter**:
Wszystko, co Trackwall wie o jednym CLI agenta: szablon komendy, konfiguracja MCP, wznowienie, detektory stanu. Jedyny adapter to Copilot CLI (ADR-8).

**Agent nadrzędny**:
CLI agenta (dziś Copilot CLI) uruchomione przez użytkownika poza zadaniem, np. w folderze z projektami, z dostępem do serwera MCP. W odróżnieniu od sesji zadania nie ma worktree, budżetu ani tokenu zadania. Pojęcie z dokumentacji i opisów narzędzi; w kodzie nie ma własnego identyfikatora, bo daemon niczego o nim nie trzyma.
_Unikaj_: orkiestrator, główny agent

**Sesja** (sesja zadania, `Session`, `SessionId`):
CLI agenta działające w PTY należącym do daemona, w korzeniu repo albo w worktree zadania (`Session.task`), jako grupa procesów, z własnym katalogiem `sessions/<sesja>/` (wtyczka sesji, `hooks.jsonl`). Widok Sesje uruchamia ją w repo jednym kliknięciem (ADR-26) albo razem z zadaniem (ADR-31). Sesja żyje tylko do wyjścia daemona, zadanie dłużej. Nagrywa ją tylko `copilot-record.ts`.
_Unikaj_: sesja POSIX (to pojęcie z grupy procesów), okno (to okno terminala w UI)

**Czeka na Ciebie** (`Session.needsAttention`):
Działająca sesja w stanie `Input`, `Approval` albo `Plan`: agent nie ruszy dalej bez człowieka. Liczy to daemon, a UI (licznik na pasku widoków, „Następna czekająca”) i tray (menu „Czeka: <repo>”, miganie okna) tylko czytają pole.

**Okno terminala** (`SessionTerminal`):
xterm.js w widoku Sesje podłączony WebSocketem `/ws/pty/<sesja>` do PTY sesji. Kilka okien może pokazywać tę samą sesję; rozmiar PTY ustala ostatnie, które go zgłosiło.

**Obraz ekranu** (`TerminalScreen`):
Stan ekranu sesji, który daemon trzyma w emulatorze terminala bez okna i wysyła oknu terminala przy podłączeniu, zanim pójdzie dalsze wyjście.
_Unikaj_: zrzut ekranu (to obrazek), historia wyjścia

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
Jedna linia wyjścia procesu po parsowaniu: `seq`, czas, uruchomienie (`runId`), strumień, poziom, treść (bez ANSI, z zamaskowanymi sekretami), później opcjonalnie identyfikator śladu (`traceId` w TypeScript, `trace_id` w narzędziach MCP).
_Unikaj_: wpis, event

**Źródło** (`LogSource`):
Skąd pochodzi rekord. Dziś task mise repo (`{ kind: "mise-task", repo, miseTask }`); serwis, zadanie i sam daemon dojdą jako kolejne rodzaje. Źródło ma rekordy wszystkich swoich uruchomień.

**Log** (log taska mise, `logs/tail` i narzędzie MCP `tail`, w UI przycisk „Log”):
Rekordy jednego źródła w kolejności `seq`: ostatnie (do 2000) w pamięci daemona, nowsze niż ostatnia rotacja w pliku JSONL `logs/<rodzaj>/<repo>/<task mise>.jsonl` w katalogu stanu (bieżący plik i jeden poprzedni, po 10 MB, ADR-28). Nie myl z logiem daemona (stderr procesu `trackwall-daemon`).
_Unikaj_: konsola, terminal (to PTY sesji zadania)

**`seq`**:
Globalny, rosnący numer rekordu dla wszystkich źródeł; każde działanie daemona zaczyna od chwili startu, więc numery się nie powtarzają. Kursor (`sinceSeq` w API i w narzędziach MCP) działa dla jednego źródła i dla całego workspace; `dropped` mówi, że część rekordów po kursorze przepadła.

**Zdarzenie**:
Wiadomość daemona na WebSocket `/ws` (`service.state`, `task.state`…) z własnym `seq` zdarzeń.
_Unikaj_: rekord (to log)

**Snapshot**:
Pełny stan z `GET /api/snapshot`, od którego UI zaczyna i do którego wraca po `resync`.

**Maskowanie**:
Zamiana wartości sekretów na `***` przed zapisem rekordu do bufora, pliku i ostatnich linii stanu. Dziś sekrety to wartości zmiennych środowiska procesu o nazwach sekretów (`GH_TOKEN`, `DB_PASSWORD`…, §4.2).

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
