# Słownik Trackwall

Pojęcia, które łatwo pomylić. Kod, UI, narzędzia MCP i dokumentacja używają tych słów i tylko tych: w polskiej prozie polskiego słowa, w UI, komunikatach daemona i opisach narzędzi MCP słowa angielskiego (*kursywą* przy haśle, ADR-32), w kodzie identyfikatora podanego przy haśle. Szczegóły są w `docs/architecture.md`; tu jest tylko to, co trzeba wiedzieć, żeby nazwać rzecz poprawnie. Nowe pojęcie dopisuje się w tym samym PR, w którym się pojawia.

## Aplikacja

**Daemon** (`daemon`):
Proces `trackwall-daemon`, który trzyma cały stan i całą logikę. Jedyne źródło prawdy; UI, CLI `ws` i agenci (przez serwer MCP w daemonie) są klientami jego fasady.
_Unikaj_: backend, serwer (bez dopowiedzenia)

**Powłoka** (`apps/desktop`):
Aplikacja Tauri: okno, tray, uruchamianie i nadzór daemona jako sidecara, sprawdzenie WebView2. Nie zawiera logiki domenowej.
_Unikaj_: aplikacja (gdy chodzi tylko o Tauri)

**Widok** (`View`; po angielsku *view*):
Ekran aplikacji w UI (Home, Repos, Sessions, Overview, Daemon, Settings), przełączany paskiem widoków (`ActivityBar`) przy lewej krawędzi okna albo skrótem.
_Unikaj_: zakładka (dla całego ekranu)

**Zakładka** (`TabBar`; po angielsku *tab*):
Przełącznik części treści wewnątrz widoku, np. README, Files, Commits i mise tasks w widoku Repos.

**Fasada** (`Facade`):
Zbiór interfejsów modułów daemona przekazywany do transportów (HTTP, MCP, zdarzenia). Moduły rozmawiają ze sobą tylko przez nią.

**Moduł**:
Wydzielona część daemona z §4 architektury (`procs`, `logs`, `workspace`…), z jawnym interfejsem i listą zależności. §4 nazywa jego interfejs „klasą serwisu”; w kodzie nie dawaj jej sufiksu `Service`, bo to słowo należy do serwisu z workspace.
_Unikaj_: serwis (to byt z workspace, patrz niżej), paczka

**Paczka**:
Pakiet pnpm z `pnpm-workspace.yaml` (`@trackwall/daemon`, `@trackwall/protocol`, `@trackwall/ui`, `@trackwall/desktop`).
_Unikaj_: workspace (to osobne pojęcie, patrz niżej)

**`ws`**:
Cienki klient CLI daemona przez HTTP na loopbacku. Nie ma nic wspólnego z WebSocketem `/ws`.

**Token daemona**:
Sekret z `~/.trackwall/daemon.json`, którym UI, `ws`, powłoka i most stdio uwierzytelniają się w API i serwerze MCP.

**Serwer MCP** (`/mcp`, `createMcpEndpoint`; po angielsku *MCP server*):
Część daemona, przez którą agenci czytają jego stan narzędziami MCP; ten sam port i token co API (§5.3, ADR-24).

**Narzędzie MCP** (`McpTool`, lista `mcpTools` w protocol, np. `list_repos`, `get_repo`, `tail`, `who_calls`, `find_endpoint`, `search_code`, `list_sessions`; po angielsku *MCP tool*):
Jedno wywołanie serwera MCP z nazwą po angielsku, wejściem i wynikiem opisanym schematem z `packages/protocol/src/mcp.ts`; mapowanie na fasadę, bez własnej logiki domenowej.
_Unikaj_: komenda, akcja (to pojęcia z API i CLI)

**Most stdio** (`trackwall-daemon mcp-stdio`, `mcpStdioCommand`; po angielsku *stdio bridge*):
Proces, który CLI agenta uruchamia jako lokalny serwer MCP; przekazuje wiadomości ze stdin do serwera MCP działającego daemona, z portem i tokenem z `daemon.json`.
_Unikaj_: proxy, cienki klient (bez dopowiedzenia)

**Token sesji** (`session-token` w katalogu sesji, nagłówek `x-trackwall-session-token`, `callerSession`):
Losowy token każdej sesji Trackwall obok tokenu daemona, który jej most stdio wysyła do serwera MCP; po nim daemon wie, która sesja woła, i np. zapisuje podsumowanie tylko do jej zadania (ADR-39, §8). Agent spoza Trackwall go nie ma.
_Unikaj_: token zadania (wcześniejszy plan; token ma każda sesja, także w korzeniu repo)

## Workspace i wiedza

**Workspace** (`workspace`):
Zbiór repo użytkownika (repo z folderu z projektami) i jego konfiguracja w `workspace.yaml`, poza repozytorium Trackwall. Tu żyje wszystko, co firmowe.
_Unikaj_: projekt

**Folder z projektami** (`projectsDir`; po angielsku *projects folder*):
Jeden katalog na dysku użytkownika, wskazany w `workspace.yaml` albo w ustawieniach. Każdy jego bezpośredni podkatalog z `.git` to repo z workspace (ADR-18); repo dodaje się, klonując je do tego folderu.
_Unikaj_: katalog workspace, root, folder (bez dopowiedzenia)

**Hosting repo** (`RepoHost`, w `workspace.yaml` `repoHosts`; po angielsku *repo host*):
GitLab albo GitHub z nazwą hosta (`gitlab.example.com`), z którego Trackwall wyszukuje repo i klonuje je do folderu z projektami przez zalogowane `glab` albo `gh` (ADR-19).
_Unikaj_: remote (to nazwa repo zdalnego w gicie, np. `origin`), serwer, źródło (to pojęcie z logów)

**Repo zdalne** (`RemoteRepo`, pełna nazwa `fullName`; po angielsku *remote repo*):
Repo w hostingu dostępne dla użytkownika, np. `grupa/podgrupa/projekt`. Ostatni segment pełnej nazwy to katalog klonu.

**Klonowanie** (`CloneJob`; po angielsku *clone*):
Klon jednego repo zdalnego do folderu z projektami, w tle: `running`, `done` albo `failed` z komunikatem. Trzymane tylko w pamięci daemona.

**Repo** (`Repo`, `RepoId`; po angielsku *repo*):
Jedno repozytorium z workspace, identyfikowane slugiem z nazwy jego katalogu.

**Adres repo zdalnego** (`Repo.remote`):
Adres głównego remote (`origin` albo jedynego remote w gicie, `mainRemote`) jako `host/ścieżka`, np. `gitlab.example.com/sklep/api`, bez protokołu i użytkownika. Identyfikuje repo niezależnie od nazwy katalogu (ADR-21).
_Unikaj_: URL repo (URL ma protokół i bywa z tokenem), remote bez dopowiedzenia (to nazwa w gicie, np. `origin`)

**Synchronizacja** (`SyncRun`, wynik repo `SyncRepo`; po angielsku *sync*):
Fetch każdego repo z folderu z projektami i fast-forward jego gałęzi domyślnej, w tle, z wynikiem per repo: przesunięte, aktualne, pominięte z powodem (`SyncSkipReason`) albo błąd; bez błędu także ze stanem katalogu roboczego po synchronizacji (`SyncWorkingTree`, ADR-34). Nigdy nie scala ani nie nadpisuje lokalnych zmian (ADR-21). Trzymana tylko w pamięci daemona.
_Unikaj_: pull, aktualizacja (bez dopowiedzenia)

**Komenda zbiorcza** (`BatchRun`, krok `BatchStep`, wynik repo `BatchRepo`; po angielsku *Batch command*):
Wybrane kroki na wybranych repo jednym przyciskiem: synchronizacja (`sync`), narzędzia z konfiguracji mise repo (`tools`, `mise install`), zależności (`setup`, task mise `setup`) i build (`build`, task mise `build`), w repo zawsze w tej kolejności, kilka repo naraz, z wynikiem każdego kroku w każdym repo (ADR-27). Błąd kroku kończy repo, pozostałe idą dalej. Trzymana tylko w pamięci daemona.
_Unikaj_: batch (w polskim tekście), operacja zbiorcza, workflow

**Stan repo** (`RepoStatus`; po angielsku *repo status*):
Gałąź, ostatni commit, liczba zmian w katalogu roboczym (z nich osobno nowe nieśledzone pliki, `untracked`) i ahead/behind względem gałęzi śledzonej, odczytane z gita przy każdym zapytaniu (`ok`), albo `unavailable` z komunikatem, gdy git go nie czyta (repo, którego katalog zniknął, znika z listy). Nigdy nie jest zapisywany.
_Unikaj_: status (w polskim tekście), sync (to osobna akcja)

**Zmiany katalogu roboczego** (`WorkingTreeChanges`, akcja `changes`; w UI zakładka „Changes”; po angielsku *changes*):
Pliki i diff katalogu roboczego (z nowymi plikami, bez ignorowanych) względem commita: repo względem HEAD w szczegółach repo (ADR-34), worktree zadania względem commita bazowego w zmianach zadania (`TaskChanges`, ADR-31). Tylko do odczytu.
W liczbach katalogu roboczego „zmienione” (`changed`) to śledzone pliki, a „nowe” (`untracked`) nieśledzone wpisy; `RepoStatus.changes` to ich suma (`trackedChanges` liczy zmienione).
_Unikaj_: diff (to tylko część), status

**Przegląd repo** (`RepoOverview`):
README i ostatnie commity repo w jednej odpowiedzi; stan repo przychodzi z listy repo. Pliki przeglądane są osobno, zawsze z commita HEAD (ADR-14).

**Code search** (`searchCode`, MCP tool `search_code`, result `SearchCodeResult`):
A fixed string or a regular expression in the files of the latest commit of many repos of the projects folder at once, through `git grep` (ADR-40); a match (`CodeMatch`) is a repo, path, line, column and context lines. It does not see uncommitted changes, just like browsing a repo.
_Avoid_: grep (the tool underneath), index (there is none)

**Worktree** (worktree zadania, `Task.worktree`; po angielsku *worktree*):
Osobny katalog roboczy gita dla zadania, na gałęzi zadania, w `worktrees/<repo>/<gałąź bez prefiksu>` w katalogu stanu, poza folderem z projektami (ADR-31). Liczony z repo i gałęzi (`taskWorktree`), nie zapisywany w `tasks.json`. Usuwany tylko na prośbę użytkownika i tylko bez działającej sesji zadania; niezacommitowane zmiany przepadają dopiero po potwierdzeniu.

**Commit bazowy** (`Task.base`; po angielsku *base commit*):
Commit gałęzi domyślnej, od którego wyszła gałąź zadania. Zmiany zadania (`TaskChanges`) to katalog roboczy worktree względem niego: commity zadania i niezacommitowane pliki razem.

**Karta** (karta repo, `RepoCard`; po angielsku *Card*):
Fakty o repo wyciągnięte deterministycznie z plików buildu, konfiguracji i kodu w commicie HEAD: pliki buildu, co repo udostępnia (`provides`), czego używa (`consumes`), wymagane narzędzia, mechanizmy i problemy, każdy fakt z dowodem. Zależy tylko od commita, więc liczy się raz na commit (ADR-25). LLM dopisze tylko opis i propozycje połączeń oznaczone `origin: 'llm'` (ADR-6). W UI zakładka „Card” w szczegółach repo.
_Unikaj_: profil, metadane; „karta repo” dla całego panelu szczegółów repo

**Plik buildu** (`BuildFile`; po angielsku *build file*):
`pom.xml`, `build.gradle(.kts)` albo `package.json`, który należy do buildu repo: korzeń (bez pliku tego samego rodzaju wyżej) albo moduł lub paczka workspace, którą wymienia inny plik buildu (`memberOf`).

**Paczka** (`ProvidedPackage`, `ConsumedPackage`; po angielsku *package*):
Artefakt Maven (`grupa:artefakt`), wtyczka Gradle albo paczka npm, którą repo udostępnia albo której używa. Paczki z tego samego repo nie są używanymi.

**Aplikacja** (`ProvidedApp`, na karcie `kind: "app"`; po angielsku *app*):
Aplikacja Spring Boot z karty repo: `spring.application.name` modułu i port z `server.port`. Po jej nazwie klient Feign, `lb://nazwa` albo host adresu wskazuje repo (ADR-30). Nie jest serwisem: serwis to proces, który Trackwall uruchamia.
_Unikaj_: serwis, mikroserwis (dla faktu z karty)

**Endpoint HTTP** (`ProvidedEndpoint`, na karcie `kind: "endpoint"`; po angielsku *HTTP endpoint*):
Metoda i pełna ścieżka (ścieżka kontekstu, prefiks kontrolera, ścieżka metody) z kontrolera Spring, z handlerem `Klasa.metoda`. Metoda `null` to każda metoda (`@RequestMapping` bez `method`). Ma typ żądania (`request`, parametr z `@RequestBody`) i typ odpowiedzi (`response`, typ zwracany bez `ResponseEntity`, `Mono` i podobnych opakowań), `null`, gdy go nie ma albo nie został przeczytany (ADR-38).

**Kontrakt endpointu** (`ProvidedEndpoint.request` i `response`, liczone przez `extractContracts`; po angielsku *request and response types*):
Typ żądania i typ odpowiedzi endpointu HTTP (`ProvidedEndpoint.request`, `response`) razem, z metody, w której leży mapowanie endpointu (ADR-38). W tekstach produktu „request and response types”.

**DTO** (`Dto`, `RepoCard.dtos`; po angielsku *DTO*):
Typ danych z repo, który endpoint przyjmuje albo zwraca, i typy jego pól: rekord, `data class`, klasa z polami (typ bez pól nie jest DTO) albo enum (rodzaj `kind`), z polami i ich typami albo stałymi enuma. Wskazuje go prosta nazwa typu, bez pakietu (ADR-38).
_Unikaj_: model, encja (dla typu z karty)

**Klient HTTP** (`ConsumedHttp`, na karcie `kind: "http"`, rodzaj `HttpClientVia`; po angielsku *HTTP client*):
Miejsce, z którego repo woła HTTP: interfejs Feign albo `@HttpExchange`, klasa z `WebClient`, `RestClient` albo `RestTemplate`, adres z konfiguracji Spring, `.env` albo proxy frontendu. Ma nazwę aplikacji celu albo adres, profile, w których ten adres obowiązuje, i wywołania. Adres na karcie nie ma użytkownika, hasła, zapytania ani członów ścieżki wyglądających na token.

**Wywołanie** (`HttpCall`; po angielsku *call*):
Metoda i ścieżka, które klient HTTP woła, z linią w kodzie. Część ścieżki znana dopiero w czasie działania to `{}`.

**Profil** (profil Spring, `ConsumedHttp.profiles`; po angielsku *profile*):
Nazwa z `application-<profil>.yml` albo `spring.config.activate.on-profile`; `default` to konfiguracja bez profilu. Klient z adresem z konfiguracji ma osobny wpis na każdy profil, w którym adres jest inny.

**Wymagane narzędzie** (`ToolRequirement`; po angielsku *required tool*):
Narzędzie i wersja z konfiguracji mise albo `.tool-versions` (źródło `mise`) lub z pliku, który podaje wersję po swojemu (`.nvmrc`, wrapper Maven, `engines.node`; źródło `hint`).

**Mechanizm** (`Mechanism`, `MechanismId`; po angielsku *mechanism*):
Technologia rozpoznana w repo po paczce albo pliku (Spring Boot, Feign, Kafka, Helm…), ze spisem dowodów. Spis, nie wniosek: mechanizm nie mówi, z kim repo się łączy.

**Ekstraktor**:
Czysta funkcja na migawce commita (`RepoSnapshot`) w `modules/cards/` (`maven.ts`, `gradle.ts`, `npm.ts`, `tools.ts`, `mechanisms.ts`, `spring.ts`, `frontend-http.ts`), która zwraca fakty z pozycją w pliku. Niczego nie wykonuje.

**Tag repo** (`RepoTag`; po angielsku *tag*):
Krótka nazwa grupy repo (`java`, `frontend`, `bff`, `monorepo`, `no-mise`…) z powodem, liczona z karty, identyfikatora i adresu repo zdalnego albo z reguły tagów. Tagi są ortogonalne: filtr z kilkoma tagami pokazuje repo, które mają wszystkie.
_Unikaj_: etykieta, kategoria

**Reguła tagów** (`repoTags` w `workspace.yaml`, `RepoTagRules`):
Tag i wzorce identyfikatora albo adresu repo zdalnego, które go nadają (`core-api: ["*-core"]`). Dla grup, których nie widać w plikach, np. zespołów.

**Graf** (graf połączeń, `RepoGraph`, moduł `graph`; po angielsku *connection graph*):
Repo z folderu z projektami jako węzły (`GraphNode`) i krawędzie między nimi, liczone z kart i z wpisów `graph` w `workspace.yaml` od nowa, gdy zmieni się commit któregoś repo albo konfiguracja. Dziś węzłem jest repo; serwisy (kilka na repo) przyjdą z modułem `services`.
_Unikaj_: mapa, diagram zależności

**Krawędź** (`GraphEdge`; po angielsku *connection*):
Połączenie od repo, które używa, do repo używanego, z rodzajem (`EdgeKind`: `package` i `http` z kart, `manual` z `workspace.yaml`; potem `topic`), kluczem (nazwa paczki, nazwa aplikacji, host albo `localhost:<port>`, opis), pewnością i dowodami. Jedna para repo może mieć kilka krawędzi; widok „Overview” rysuje je jedną linią.

**Alias paczki** (`graph.packages` w `workspace.yaml`):
Nazwa paczki i repo, które ją dostarcza, gdy karta tego repo jej nie pokazuje (paczka budowana poza plikami buildu, inna nazwa w repozytorium artefaktów). Działa tylko dla paczki, której nie buduje żadne repo z listy.

**Alias aplikacji** (`graph.apps` w `workspace.yaml`):
Nazwa aplikacji albo host adresu (bez wielkości liter) i repo, które je obsługuje, gdy żadna karta nie ma tej nazwy (adres bramki, nazwa w DNS inna niż `spring.application.name`).

**Ręczna krawędź** (`ManualEdge`, `graph.edges` w `workspace.yaml`):
Połączenie wpisane przez użytkownika (`from`, `to`, `note`), np. wywołanie HTTP, którego karty jeszcze nie widzą. Repo wskazuje się identyfikatorem albo adresem repo zdalnego (`RepoRef`).

**Dowód** (`Evidence`, w grafie `EdgeEvidence`; po angielsku *evidence*):
Plik i linia, z których wynika fakt na karcie lub krawędź w grafie; dowód krawędzi ma też repo (albo `null` dla `workspace.yaml`) i zdanie, co w tym miejscu jest.

**Pewność** (`confidence`, w grafie `EdgeConfidence`; po angielsku *confidence*):
`exact`, `high`, `medium` albo `low`. Krawędź z paczki budowanej przez jedno repo i ręczna krawędź są `exact`, z aliasu paczki `high`, z paczki budowanej przez kilka repo `medium`. Krawędź HTTP: `exact`, gdy nazwa aplikacji wskazuje jedno repo, a każde wywołanie ma w nim endpoint, `high` za samą nazwę aplikacji albo alias aplikacji, `medium` za host równy nazwie repo, port na `localhost` albo ścieżki pasujące do jednego repo, `low` za ścieżki pasujące do kilku repo (ADR-30). W UI: certain, almost certain, likely, possible. Przy `low` daemon niczego nie robi automatycznie.

**Przegląd** (widok „Overview”, `GraphView`, identyfikator widoku `graph`; po angielsku *Overview*):
Widok z grafem połączeń na całą szerokość i panelem szczegółów wybranego repo (kogo używa, kto używa jego, dowody).
_Unikaj_: dashboard (to scena 3D), przegląd repo (to README i commity jednego repo, `RepoOverview`)

## Procesy i serwisy

**Serwis** (`Service`, `ServiceId`; po angielsku *service*):
Repo plus jego task mise `dev`, port i sonda zdrowia. Jedno repo może mieć kilka serwisów.
_Unikaj_: aplikacja, mikroserwis (gdy chodzi o byt w Trackwall)

**Stan serwisu**:
`stopped`, `starting`, `healthy`, `unhealthy`, `stopping` albo `crashed`; zawsze zaobserwowany, nigdy założony.

**Grupa procesów** (`ProcessGroup`; po angielsku *process group*):
Proces-lider i wszyscy jego potomkowie, zatrzymywani razem: Job Object na Windowsie, nowa sesja POSIX (`setsid`) z zabijaniem po `-pgid` na macOS.
_Unikaj_: drzewo procesów (gdy chodzi o jednostkę zarządzaną)

**Właściciel grupy** (`owner`):
Klucz, pod którym `procs` trzyma grupę procesów i jej ostatni stan; nadaje go moduł, który ją uruchomił (dziś task mise w repo). Jeden właściciel ma najwyżej jedną grupę, która nie jest potwierdzona jako pusta.

**Sonda** (health):
Task mise `health` uruchamiany cyklicznie; jego wynik decyduje o `healthy` / `unhealthy`.

**Dzierżawa** (`Lease`):
Informacja, która gałąź albo worktree zajmuje serwis na jego porcie. Domyślnie repo główne; zadanie może ją przejąć i oddać.
_Unikaj_: lock, rezerwacja

**Sierota** (po angielsku *orphan*):
Grupa procesów z `runtime.json`, której daemon już nie nadzoruje (np. po awarii). Sprzątana przy starcie daemona tylko, gdy lider to ten sam proces (ten sam czas startu) albo już nie żyje, a grupa tak.

## Agenci

**Zadanie** (`Task`, `TaskId`; po angielsku *task*):
Praca jednego agenta nad jednym repo: polecenie, worktree, gałąź `trackwall/<skrót>` od gałęzi domyślnej, sesje i podsumowanie; docelowo także budżet i dzierżawy. Dziś (ADR-31) tworzy je widok Sessions z formularza albo z zatwierdzonej propozycji zadania (ADR-39), zapisuje `tasks.json`, a sesję zadania można zatrzymać i wznowić. Zadanie nie wskazuje sesji; to sesja ma `Session.task`. W kodzie i API `task` znaczy zawsze zadanie.
_Unikaj_: job; „task” w polskim tekście (myli się z taskiem mise); w tekście po angielsku gołe *task* znaczy tylko zadanie, a task mise to zawsze *mise task*

**Zakończenie zadania** (`removeTask`, „End task” w UI; po angielsku *End task*):
Usunięcie worktree zadania, a do wyboru także jego gałęzi. Tylko bez działającej sesji; to, co by przepadło (niezacommitowane pliki, commity z odłączonego HEAD, katalog, którego git już nie zna, a z gałęzią także commity zadania), daemon wymienia w odmowie `unsaved_changes`, a przepada ono dopiero po potwierdzeniu. Pliki ignorowane przez gita przepadają zawsze.
_Unikaj_: usunięcie zadania (zadanie znika z listy, ale gałąź może zostać)

**Polecenie** (`Task.prompt`; po angielsku *prompt*):
Treść zadania dla agenta, wpisana w widoku Sessions albo przyniesiona przez propozycję zadania (i poprawiona przez użytkownika przed startem); Copilot CLI dostaje ją jako pierwszą wiadomość sesji zadania (`--interactive`).
_Unikaj_: prompt (w polskim tekście)

**Tytuł zadania** (`Task.title`, `TaskTitle`; po angielsku *title*):
Krótki opis zadania w jednej linii (do 80 znaków), który nadaje sesja proponująca zadanie, jak tytuł wątku; z niego powstaje skrót gałęzi. Zadanie z formularza nie ma tytułu (`null`), a UI pokazuje wtedy polecenie.
_Unikaj_: tytuł okna (to `windowTitle` sesji)

**Propozycja zadania** (`TaskProposal`, narzędzie MCP `propose_task`, akcje `approve-proposal` i `reject-proposal`; po angielsku *task proposal*):
Zadanie, które sesja albo agent spoza Trackwall zgłosił przez MCP, a które czeka w widoku Sessions na decyzję użytkownika: „Start task” robi z niej zadanie z tym samym identyfikatorem, „Reject” ją odrzuca. Do tej chwili nic się nie uruchamia. Żyje tylko w pamięci daemona (ADR-39).
_Unikaj_: zlecenie, prośba, wniosek

**Sesja główna** (`proposedBy` zadania i propozycji; po angielsku *main session*):
Sesja albo agent nadrzędny, który rozmawia z użytkownikiem i zleca pracę innym agentom propozycjami zadań, a potem czeka na ich sesje (`wait_for_session`) i czyta podsumowania, jak koordynator z wątkami w Claude (ADR-39). To rola, nie osobny rodzaj sesji: dziś to każda sesja Trackwall albo agent spoza Trackwall (`proposedBy.session: null`).
_Unikaj_: orkiestrator, planner (ADR-9: rozbijanie celów robi człowiek)

**Task mise** (po angielsku *mise task*):
Nazwana komenda z `mise.toml` repo: `setup`, `dev`, `test`, `build`, `lint`, `health`. W kodzie zawsze z dopowiedzeniem (`miseTask`, `mise.run(...)`), nigdy gołe `task`. Taski zapisane w commicie (`DeclaredMiseTask` w `RepoCard.mise`, typ `MiseSetup`: pliki konfiguracji mise i taski z `[tasks]` oraz katalogów tasków) liczy karta repo; repo bez nich ma tag `no-mise` (ADR-34). Jedyny wyjątek to argument `task` narzędzia MCP `run_task` (§5.3), gdzie kontekst jest jednoznaczny.

**Uruchomienie** (`run`, `runId`, stan: `RunState`; po angielsku *run*):
Jednorazowe wykonanie taska mise przez `run_task` albo z UI, z własną grupą procesów i logami. Stan `running`, `stopping` albo `exited` (kod wyjścia, sygnał, czy zatrzymał je użytkownik, ostatnie linie wyjścia), zawsze zaobserwowany. Nie jest zadaniem ani serwisem.

**Zaufanie mise** (`mise trust`, akcja `trust`; po angielsku *trust*):
Zgoda użytkownika, żeby mise czytał konfigurację repo, która może uruchamiać programy (`[env]`, szablony, hooki). Bez niej mise nie poda listy tasków (`untrusted`). Daje się tylko w UI.
_Unikaj_: autoryzacja, akceptacja

**Adapter**:
Wszystko, co Trackwall wie o jednym CLI agenta: szablon komendy, konfiguracja MCP, wznowienie, detektory stanu. Jedyny adapter to Copilot CLI (ADR-8).

**Agent nadrzędny**:
CLI agenta (dziś Copilot CLI) uruchomione przez użytkownika poza zadaniem, np. w folderze z projektami, z dostępem do serwera MCP. W odróżnieniu od sesji zadania nie ma worktree, budżetu ani tokenu sesji. Pojęcie z dokumentacji i opisów narzędzi; w kodzie nie ma własnego identyfikatora, bo daemon niczego o nim nie trzyma.
_Unikaj_: orkiestrator, główny agent

**Sesja** (sesja zadania, `Session`, `SessionId`; po angielsku *session*):
CLI agenta działające w PTY należącym do daemona, w korzeniu repo albo w worktree zadania (`Session.task`), jako grupa procesów, z własnym katalogiem `sessions/<sesja>/` (wtyczka sesji, `hooks.jsonl`). Widok Sessions uruchamia ją w repo jednym kliknięciem (ADR-26) albo razem z zadaniem (ADR-31). Sesja żyje tylko do wyjścia daemona, zadanie dłużej. Nagrywa ją tylko `copilot-record.ts`.
_Unikaj_: sesja POSIX (to pojęcie z grupy procesów), okno (to okno terminala w UI)

**Waiting for you** (`Session.needsAttention`, `SessionAttention`; Polish *czeka na Ciebie*):
A running session in `Approval` or `Plan`, or in `Input` the user has not seen yet (ADR-47): the agent will not move on without a human, and the human does not know yet. The daemon computes it; the UI (the counter on the activity bar, which also counts task proposals waiting for a decision, ADR-39; "Next waiting") and the tray (the "Waiting: <repo>" menu, the flashing window) only read the field.

**Seen** (`SessionAttention.focus`, `typed`; the `focus` frame of `PtyClientMessage`):
The user has seen the session's current `Input`: a session terminal window was focused and visible, or the user typed into the session, after the state began.
_Avoid_: read, acknowledged

**Idle** (`isIdle`, `IDLE_LABEL`, dashboard state `idle`):
A running session in `Input` the user has already seen (ADR-47): the agent waits for the next prompt, but no longer waits for you. Shown as "idle" in Sessions and in calm grey on the dashboard.

**Okno terminala** (`SessionTerminal`; po angielsku *session terminal*):
xterm.js w widoku Sessions podłączony WebSocketem `/ws/pty/<sesja>` do PTY sesji. Kilka okien może pokazywać tę samą sesję; rozmiar PTY ustala ostatnie, które go zgłosiło.

**Session layout** (`SessionLayout`):
How the right side of the Sessions view shows entries (ADR-48): `1` is the selected entry alone with its full panel (tabs, Stop, Resume), `2` and `4` a grid page of that many entries, `auto` a grid of the whole list, up to nine per page.
In the Sessions view the switch is labelled just "Layout".
_Avoid_: view (that is a screen of the app), mode

**Session grid** (`SessionGrid`, tile):
Several session terminals side by side in the Sessions view, one tile per list entry, on pages of the list. The tile of the selected entry has the accent ring and takes the keyboard; a tile that is waiting for you has the warning frame.
_Avoid_: split, dashboard (that is Home)

**Session shortcut** (`SessionShortcut`; Alt+1…9, Alt+J):
Alt (⌥ on macOS) + digit selects the entry at that position in the Sessions list; Alt+J opens the next session that is waiting for you, also from other views. A shortcut never reaches the session terminal.

**Obraz ekranu** (`TerminalScreen`):
Stan ekranu sesji, który daemon trzyma w emulatorze terminala bez okna i wysyła oknu terminala przy podłączeniu, zanim pójdzie dalsze wyjście.
_Unikaj_: zrzut ekranu (to obrazek), historia wyjścia

**Stan zadania** (`TaskState`, zmiana: `TaskStateChange`; po angielsku *state*):
`Working`, `Input`, `Approval`, `Plan`, `Done`, `Error` albo `Stale`, zawsze ze źródłem (`hook`, `osc`, `screen`, `keyboard`, `timeout`, `exit`) i pewnością (§4.4).

**Detektor stanu**:
Reguła, która z hooków, sekwencji terminala, wyglądu ekranu albo klawiszy człowieka w terminalu sesji wnioskuje stan zadania.

**Klawisz sesji** (`SessionKey`, `sessionKey`; po angielsku *key*):
Enter, cyfra 1–9, Esc albo Ctrl+C wysłany do terminala sesji jako cały kawałek wejścia (`enter`, `choice`, `escape`, `interrupt`). Odpowiada na prośbę o zgodę albo przerywa turę, czego Copilot CLI nie zgłasza hookiem, więc jest źródłem stanu `keyboard`; nagranie zapisuje sam rodzaj klawisza.
_Unikaj_: wejście (to cała treść z klawiatury), skrót

**Wtyczka sesji** (`writeCopilotPlugin`; po angielsku *session plugin*):
Katalog z `plugin.json` i `hooks.json`, który daemon podaje Copilot CLI przez `--plugin-dir`, żeby hooki zgłaszały stan tylko tej jednej sesji (ADR-17).
_Unikaj_: plugin (w polskim tekście), konfiguracja hooków

**Instrukcje sesji** (`writeSessionInstructions`, file `trackwall.instructions.md`; in English *session instructions*):
The instruction file in the session directory that the daemon gives Copilot CLI through `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`: the session's role (a main session in the repo root, or a task session in its worktree with the task rules and `report_result` at the end) and the **MCP instruction** (`MCP_INSTRUCTIONS`, also the MCP server's `instructions`): when to reach for which Trackwall tool (ADR-46). It changes neither the repo nor `~/.copilot`.
_Avoid_: system prompt (Copilot CLI builds it itself), repository instructions (those are files in the user's repo)

**Rekord hooka** (`CopilotHookRecord`):
Jedno wywołanie hooka z wtyczki sesji: zdarzenie, czas odebrania i tylko pola payloadu potrzebne do stanu, a o reszcie same nazwy (bez promptu, argumentów i wyników narzędzi). Linia `hooks.jsonl` i znacznik w nagraniu.
_Unikaj_: rekord (bez dopowiedzenia; to linia logu)

**Tytuł okna** (`windowTitle`):
Tytuł, który CLI agenta ustawia sekwencją OSC 0 / 2; w Copilot CLI to opis bieżącej pracy. Pokazywany obok stanu, nigdy nie jest stanem.
_Unikaj_: intencja, intent

**Nagranie** (nagranie sesji, `session.cast`):
Wyjście sesji w formacie asciicast v2 ze znacznikami rekordów hooków, klawiszy sesji i kodu wyjścia, z którego da się policzyć stan jeszcze raz (`replayCopilotRecording`). Bez treści wejścia z klawiatury.

**Budżet**:
Limit czasu i liczby commitów zadania; po przekroczeniu daemon kończy sesję.

**Podsumowanie** (`Task.summary`, narzędzie MCP `report_result`; po angielsku *summary*):
Wynik, który sesja zadania zgłasza narzędziem `report_result`: co zrobiła, co zostało, co sprawdzić. Trafia do pola `summary` zadania (z czasem zgłoszenia, w `tasks.json`), do widoku Sessions i do sesji głównej; kolejne zastępuje poprzednie (ADR-39). Docelowo także do propozycji PR. Trackwall niczego sam nie scala (ADR-9).

## Logi, zdarzenia i audyt

**Rekord** (`LogRecord`):
Jedna linia wyjścia procesu po parsowaniu: `seq`, czas, uruchomienie (`runId`), strumień, poziom, treść (bez ANSI, z zamaskowanymi sekretami), później opcjonalnie identyfikator śladu (`traceId` w TypeScript, `trace_id` w narzędziach MCP).
_Unikaj_: wpis, event

**Źródło** (`LogSource`):
Skąd pochodzi rekord. Dziś task mise repo (`{ kind: "mise-task", repo, miseTask }`); serwis, zadanie i sam daemon dojdą jako kolejne rodzaje. Źródło ma rekordy wszystkich swoich uruchomień.

**Log** (log taska mise, `logs/tail` i narzędzie MCP `tail`, w UI przycisk „Log”; po angielsku *log*):
Rekordy jednego źródła w kolejności `seq`: ostatnie (do 2000) w pamięci daemona, nowsze niż ostatnia rotacja w pliku JSONL `logs/<rodzaj>/<repo>/<task mise>.jsonl` w katalogu stanu (bieżący plik i jeden poprzedni, po 10 MB, ADR-28). Nie myl z logiem daemona (stderr procesu `trackwall-daemon`).
_Unikaj_: konsola, terminal (to PTY sesji zadania)

**Błąd z logu** (`LogError`, MCP tool `get_errors`; in English *error*):
A record at `error` (or `warn`) level or an exception header together with the lines that belong to it (stack trace, `Caused by:`, a Spring or Gradle report), from one source, run and stream. The same error repeated in a source is one error with a count (`count`); `exception` is its cause (ADR-42).
_Unikaj_: exception (only one kind of error), problem (that is the repo card and the graph), incident

**`seq`**:
Globalny, rosnący numer rekordu dla wszystkich źródeł; każde działanie daemona zaczyna od chwili startu, więc numery się nie powtarzają. Kursor (`sinceSeq` w API i w narzędziach MCP) działa dla jednego źródła i dla całego workspace; `dropped` mówi, że część rekordów po kursorze przepadła.

**Zdarzenie** (`DaemonEvent`, `sessions.changed`, `mise.running.changed`; po angielsku *event*):
Wiadomość daemona na WebSocket `/ws` (ADR-36) z całą migawką jednego tematu, bez numeru. Daemon wysyła je po podłączeniu (migawka każdego tematu) i przy każdej zmianie migawki.
_Unikaj_: rekord (to log), powiadomienie (to OSC albo hook)

**Migawka tematu** (`payload` zdarzenia, `LiveFeed` w UI; po angielsku *snapshot*):
Cały stan jednego tematu zdarzeń, ta sama wartość co odpowiedź akcji HTTP (`SessionList` z `agents/sessions`, `RunningMiseTask[]` z `mise/running`). Nie myl z migawką pulpitu (`HomeModel`), którą UI składa z kilku tematów i odpowiedzi.

**Maskowanie**:
Zamiana wartości sekretów na `***` przed zapisem rekordu do bufora, pliku i ostatnich linii stanu. Dziś sekrety to wartości zmiennych środowiska procesu o nazwach sekretów (`GH_TOKEN`, `DB_PASSWORD`…, §4.2).

**Audyt** (`AuditEntry`):
Zapis każdego wywołania narzędzia MCP: klient, narzędzie, argumenty, czas, skrót wyniku. Widoczny tylko w UI.

## Sekrety

**Repo sekretów**:
Repozytorium z manifestami k8s `Secret`, po jednej gałęzi `origin/<repo>` na repo z workspace (ADR-10). Klonowane poza workspace.

**Sekret** (po angielsku *secret*):
Klucz z `data` albo `stringData` manifestu, wstrzykiwany jako zmienna środowiskowa o tej samej nazwie. Sesja zadania widzi tylko, czy jest ustawiony.

## Scena 3D

**Scena** (`@trackwall/scene`, `HomeScene`):
Scena 3D pulpitu na Pawn. Nie zna API daemona: dostaje kolejne migawki `HomeModel` i trzyma jedną encję na obiekt.

**Pulpit**:
Pierwszy ekran, widok „Home” (`HomeView`): stan daemona, sesje (zwłaszcza czekające na Ciebie), repo i połączenia między nimi, w układzie „Orbit” (`orbitLayout`).

**Kolejka „Needs you”** (`NeedsYouPanel`):
Lewy panel pulpitu: sesje, które czekają na Ciebie albo mają błąd, potem repo, które nie są czyste. Te same obiekty mają podpis na scenie.

**Migawka pulpitu** (`HomeModel`):
To, co pulpit pokazuje, policzone przez UI z odpowiedzi daemona i podane scenie w całości przy każdej zmianie.
_Unikaj_: snapshot (po angielsku to migawka tematu zdarzeń).

**Warstwa** (`HomeRepo.layer`, `HomeModel.layerCount`):
Poziom repo na pulpicie, ta sama kolumna co w widoku „Przegląd”: najdłuższa ścieżka od repo, którego nikt nie używa (wejścia po jednej stronie, biblioteki po drugiej). Repo bez połączeń nie ma warstwy (`null`).

**Rodzaj repo** (`RepoKind`: `entry`, `gateway`, `backend`, `library`):
Rola repo w grafie wyliczona z warstwy: wejście, brama, backend, biblioteka.
_Unikaj_: serwis (to proces z konfiguracji repo). Na pulpicie każdy rodzaj ma inną bryłę.
