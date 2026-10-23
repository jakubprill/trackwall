# Architektura Trackwall

Stan: propozycja do dyskusji, 2026-10-23. Wcześniejsza robocza nazwa „Pitwall” została zmieniona na „Trackwall” (ADR-12).

Ten dokument opisuje, jak aplikacja jest podzielona na komponenty, gdzie przebiegają granice między modułami, jakimi protokołami komponenty rozmawiają, jaki jest model danych, jak wyglądają najważniejsze przepływy i jakie ryzyka niesie Windows jako platforma główna. Wizja produktu (cel, moduły, kolejność prac) jest założeniem tego dokumentu, a nie jego treścią. Decyzje, które warto umieć później cofnąć, są zebrane na końcu jako ADR-y.

## 1. Zasady, które porządkują resztę

1. **Daemon jest jedynym źródłem prawdy.** UI, serwer MCP i CLI `ws` to trzy klienty tej samej fasady usług w daemonie. Dashboard i agent nigdy nie różnią się co do stanu, bo pytają ten sam obiekt.
2. **Daemon zna identyfikatory, nie komendy.** Każda akcja z zewnątrz (MCP, CLI, UI) wskazuje repo, serwis, zadanie lub task mise po identyfikatorze. Komendę składa daemon z konfiguracji. Jedyny wyjątek to terminal interaktywny w UI.
3. **Stan procesów jest obserwowany, nie deklarowany.** „Zatrzymany” znaczy, że cała grupa procesów nie żyje i daemon to sprawdził. „Działa” znaczy, że sonda zdrowia odpowiedziała.
4. **Fakty deterministycznie, LLM tylko dopisuje.** Karta repo i graf powstają z plików buildu i konfiguracji. Model językowy dodaje opis i sugestie, nigdy nie jest źródłem pola technicznego.
5. **Sekrety nie przechodzą przez agenta.** Daemon wstrzykuje je do środowiska procesu i maskuje w logach. Narzędzia MCP odpowiadają „ustawiony / brak”, nigdy wartością.
6. **Nic firmowego w kodzie.** Adresy, nazwy repo, ścieżki, reguły wykrywania specyficzne dla firmy żyją w lokalnym workspace, poza repozytorium projektu.
7. **Windows pierwszy.** Każdy mechanizm (procesy, PTY, ścieżki, sygnały) jest projektowany od strony Windowsa, a macOS dostaje odpowiednik. Odwrotna kolejność kończy się warstwą „na Windowsie trochę inaczej”.

## 2. Widok ogólny

```
┌──────────────────────────────────────────────────────────────────┐
│  desktop (Tauri)                                                 │
│  okno WebView ─ tray ─ autostart ─ nadzór sidecara ─ aktualizacje│
│      │ ładuje                                  │ uruchamia       │
│      ▼                                         ▼                 │
│  ui (React + Tailwind + shadcn/ui)        daemon (TS, 1 binarka) │
│  panele: Zadania, Serwisy, Logi (xterm),  ┌────────────────────┐ │
│  Diff (Monaco), Graf, Sekrety, Audyt      │ fasada usług       │ │
│  scena 3D: @trackwall/scene (Pawn)        │  workspace  cards  │ │
│      │ HTTP + WebSocket (loopback, token)  │  graph      tasks  │ │
│      └────────────────────────────────────▶│  procs      leases │ │
│                                            │  logs       secrets│ │
│   CLI `ws` ──────── HTTP (loopback) ──────▶│  agents     audit  │ │
│                                            └───┬──────────┬─────┘ │
│   Copilot CLI / inne CLI ── MCP (HTTP lub stdio) ─┘          │     │
│                                                   SQLite + JSONL   │
│                                                   ~/.trackwall/    │
└──────────────────────────────────────────────────────────────────┘
```

Cztery procesy na maszynie użytkownika:

| Proces | Rola | Żyje, gdy okno zamknięte? |
|---|---|---|
| `trackwall.exe` (Tauri) | okno, tray, nadzór daemona, aktualizacja | tak, w trayu |
| `trackwall-daemon.exe` (sidecar) | cała logika: workspace, procesy, logi, zadania, MCP | tak |
| procesy serwisów | `mise run dev` w grupie procesów per serwis | tak |
| sesje agentów | CLI agenta w PTY należącym do daemona | tak |

Daemon można też uruchomić bez Tauri (`trackwall-daemon --ui`), co daje tryb „lokalna strona w przeglądarce” z pierwszego etapu prac. Tauri niczego nie dodaje do logiki, tylko do pakowania i integracji z systemem.

## 3. Monorepo

```
trackwall/
  package.json            pnpm workspaces, skrypty root
  pnpm-workspace.yaml
  mise.toml               wersje narzędzi dla samego projektu (node/bun, pnpm, rust) i taski setup, dev, portable
  packages/
    protocol/             typy zdarzeń, DTO, schemat JSON API (zod); zero zależności runtime
    daemon/               binarka daemona; src/ podzielone na moduły z §4
    ui/                   React, Vite; buduje statyczne pliki serwowane przez daemon lub Tauri
    scene/                adapter Pawn: stan ze WebSocket -> encje koota, render on demand
    cli/                  `ws` (cienki klient HTTP do daemona); wspólny kod z daemonem przez protocol
  apps/
    desktop/              Tauri (Rust shell), tauri.conf, ikony, sidecar binarka daemona
  docs/
    architecture.md       ten dokument
    release.md            proces wydania i instalacja
    release-notes/        notatki o zmianach per wersja (v<wersja>.md), opis GitHub Release
    adr/                  decyzje architektoniczne (od chwili, gdy zacznie ich przybywać)
  .github/workflows/
    ci.yml                przy PR: lint (Biome, knip, rustfmt), typecheck, test na Linuksie, audyt; na main i ręcznie: do tego test, clippy, build portable, spike'i na Windows + macOS
    release.yml           wydanie z tagu vX.Y.Z (docs/release.md)
  .github/actions/setup/  wspólne przygotowanie jobów: pnpm, Node, Bun, pnpm install
  .github/dependabot.yml  cotygodniowe aktualizacje akcji, npm i cargo
```

`packages/protocol` jest jedyną zależnością wspólną między daemonem, UI, sceną i CLI. Dzięki temu UI nie importuje nic z daemona (nie da się przypadkiem wciągnąć `node:child_process` do bundle'a WebView), a schematy zod są jednocześnie walidacją wejścia w daemonie i typami w UI.

## 4. Daemon: moduły i granice

Daemon jest jednym procesem, ale wewnątrz jest podzielony na moduły z jawnie zadeklarowanym interfejsem. Każdy moduł wystawia klasę serwisu, a fasada (`Facade`) jest po prostu zbiorem tych serwisów przekazanym do trzech transportów (HTTP, MCP, zdarzenia). Moduł nie importuje innego modułu bezpośrednio, tylko przez fasadę, więc graf zależności między modułami jest widoczny w jednym pliku.

W kodzie: moduł to katalog `packages/daemon/src/modules/<moduł>/`, fasada to `packages/daemon/src/facade.ts`. Moduł, który potrzebuje innego, deklaruje u siebie interfejs z tym, czego używa (np. `WorkspaceVcs`), a `createFacade` podaje mu instancję tamtego modułu. Biome pilnuje obu stron: plik modułu nie importuje z sąsiedniego katalogu modułu (z zewnątrz tylko pliki infrastruktury z `src/` i `src/platform/`, więc moduł jest płaskim katalogiem), a kod poza modułami (transporty, start) sięga do modułów tylko przez `facade.ts`.

| Moduł | Odpowiada za | Zależy od | Trwały stan |
|---|---|---|---|
| `workspace` | repo z folderu z projektami, klon do niego, sync, stan per repo, przeglądanie zawartości, `ws sync` | `vcs` (`ws sync` z `mise run setup` będzie składał oba moduły ponad nimi) | `workspace.yaml` (ADR-13, ADR-18), tabela `repos` |
| `vcs` | adaptery git (lokalne), GitHub, GitLab; worktree; `git show` bez checkoutu; stan, log, drzewo i pliki z HEAD | – | – |
| `mise` | lista tasków repo, uruchamianie tasków po nazwie (§4.7); później generowanie `mise.local.toml` i wykrywanie stacku | `procs`, `workspace` (korzeń repo po identyfikatorze) | pliki w repo |
| `cards` | analiza repo -> karta (provides / consumes / runtime); uzupełnienie przez LLM | `workspace` | tabela `cards` z commitem analizy |
| `graph` | złączenie kart w graf; zapytania `who_calls`, `subgraph_for`, `find_endpoint` | `cards` | liczony w pamięci, cache w SQLite |
| `procs` | grupy procesów, start/stop z eskalacją, sieroty, port -> właściciel | – | `runtime.json` (grupy żywe, §4.1) |
| `logs` | magistrala: ring buffer, JSONL, sekwencje, kursory, maskowanie, `trace` | `secrets` (maski) | `logs/<repo>/<proces>.jsonl` |
| `services` | serwis = repo + task `dev` + port + sonda; dzierżawy | `procs`, `mise`, `logs`, `leases` | tabela `services` |
| `leases` | kto trzyma serwis na jakim porcie; przejęcie przez zadanie | – | tabela `leases` |
| `secrets` | repo sekretów (manifesty k8s `Secret`), odczyt `git show origin/<app>:<plik>`, wstrzyknięcie do env, `check_secrets` | `vcs` | klon poza workspace |
| `agents` | adaptery CLI, PTY, wykrywanie stanu, worktree per zadanie, budżet, nagrywanie | `vcs`, `procs`, `logs`, `leases` | tabela `tasks`, nagrania `sessions/` |
| `mcp` | serwer MCP: mapowanie narzędzi na fasadę, audyt | wszystko przez fasadę | tabela `audit` |
| `api` | HTTP + WebSocket dla UI i CLI, token, CORS, statyczne pliki UI | wszystko przez fasadę | – |

Dwa moduły są „fundamentem”: `procs` i `logs`. Nie zależą od niczego i wszystko inne na nich stoi, więc powstają najpierw i dostają najwięcej testów, w tym na Windowsie.

### 4.1 `procs`: grupy procesów

- Start zawsze tworzy **grupę** (ADR-20): na Windowsie Job Object z `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` przez `bun:ffi`, na macOS i Linuksie nowa sesja (`setsid`, w Node `detached`) i sygnały do `-pgid`. Dziecko mise, które odpala mvn, który odpala javę, jest jedną jednostką. Na Windowsie lider trafia do joba zaraz po `spawn` (Node nie umie uruchomić procesu wstrzymanego); potomek utworzony w tej chwili, zanim lider trafi do joba, wypadłby z grupy, ale `mise` startuje kilka milisekund, zanim cokolwiek uruchomi. Kod systemowy jest w `platform/` (`GroupPlatform`), moduł `procs` (`ProcessGroups`) zna tylko interfejs.
- Właściciel grupy (`owner`) to klucz wołającego (dziś task mise w repo, budowany w module `mise` i nigdy nierozbierany z powrotem); na właściciela przypada jedna grupa, a drugi start zwraca stan pierwszej, dopóki ta nie jest potwierdzona jako pusta. Po końcu zostaje ostatni stan do następnego startu, w pamięci daemona. Stop w trakcie startu czeka na grupę, a po rozpoczęciu wyjścia daemona nowe grupy nie powstają.
- Stop eskaluje: łagodny sygnał (macOS i Linux: SIGTERM do grupy; Windows: zamknięcie stdin lidera, bo `GenerateConsoleCtrlEvent` wymaga wspólnej konsoli, której proces z ukrytym oknem nie ma), po czasie łaski (5 s; na Windowsie 2 s, bo zamknięcia stdin większość serwerów nie słucha) zabicie całej grupy (`SIGKILL` do `-pgid`, `TerminateJobObject`) i do 3 s czekania na pustą grupę, razem w 10 s, które powłoka czeka na zatrzymanie daemona (§5.4). Ta sama droga zatrzymuje sieroty przy starcie. **Stop zwraca sukces dopiero po potwierdzeniu**, że żaden proces grupy nie żyje (`kill(-pgid, 0)` daje `ESRCH`, job ma zero aktywnych procesów); inaczej błąd `stop_unconfirmed`, a uruchomienie zostaje `stopping`. Port nie jest jeszcze sprawdzany: przyjdzie z serwisami, które znają swój port.
- Lider, który zakończył się sam, zabiera resztę grupy: daemon zabija to, co zostało, i dopiero po potwierdzeniu pustej grupy uruchomienie jest `exited` (kod wyjścia, sygnał, czy zatrzymał je użytkownik i ostatnie linie wyjścia). Do tego czasu jest `stopping`, a grupa, której nie udało się zabić, zostaje w `runtime.json` i blokuje nowy start tego właściciela.
- Rejestr grup w `runtime.json` (w katalogu stanu): właściciel, komenda, katalog, PID lidera i jego czas startu według systemu (`ps -o lstart` ze stałymi `TZ=UTC` i `LC_ALL=C`, z dokładnością do sekundy). Grupa trafia tam po starcie i znika po potwierdzonym końcu; sierota, której nie udało się zabić, zostaje do następnego startu. Plik, którego nie da się odczytać, jest odkładany obok (`runtime.json.broken-<czas>`), a nieudany zapis trafia do logu i nie zmienia stanu w pamięci. Przy starcie daemona, pod blokadą startu i przed otwarciem API, sieroty są sprzątane tylko, gdy lider to ten sam proces: żyje z tym samym czasem startu (PID-y są recyklingowane) albo już nie żyje, a grupa o jego identyfikatorze tak (system nie nadaje PID-u, dopóki żyje grupa o tym numerze). Żywy PID z innym czasem startu (albo bez zapisanego czasu) nie jest zabijany: trafia do logu i znika z `runtime.json`, bo kolejne starty i tak nie rozstrzygną, czy to nasz proces. Na Windowsie pod Bun sierot nie ma, bo zamknięcie uchwytu joba przy śmierci daemona zabija grupę; pod Node daemon tylko zgłasza żywy PID.
- Wyjście daemona (Ctrl-C, sygnał, `POST /api/daemon/shutdown`) zatrzymuje wszystkie grupy tym samym stopem, równolegle, przed zamknięciem API.
- stdout i stderr są zawsze czytane (nieczytany pipe blokuje dziecko przy ok. 64–192 KB). Dziś zostaje z nich tylko 20 ostatnich linii (bez sekwencji ANSI i nadpisanego `\r` postępu) dla stanu `exited`; moduł `logs` podłączy się w tym samym miejscu (`attachOutput` w `process-groups.ts`).
- Katalog roboczy musi być pełną ścieżką istniejącego katalogu; wołający podaje korzeń repo lub worktree. Środowisko to środowisko daemona bez `TRACKWALL_HOME`, a na macOS z `PATH` z powłoki logowania użytkownika (`user-env.ts`): aplikacja otwarta z Findera dostaje od launchd tylko systemowy `PATH`, bez Homebrew i `~/.local/bin`.
- `portOwner(port)` zwraca właściciela z poziomem pewności: `exact` (PID z naszej grupy), `high` (potomek naszej grupy), `medium` (komenda pasuje do serwisu), `low`. Przy `low` daemon nie podejmuje akcji automatycznie. (Jeszcze nie zrobione.)

### 4.2 `logs`: magistrala

- Rekord: `{ seq, ts, source: {kind: 'service'|'task'|'daemon', id}, stream, level, msg, trace_id?, span_id?, fields, raw }`.
- Jeden **globalny** `seq` dla wszystkich źródeł; kursor `since_seq` działa dla jednego serwisu i dla całego workspace. Kursor starszy niż bufor zwraca `dropped: true`.
- Ring buffer per źródło (domyślnie 2000 rekordów) dla UI i MCP; JSONL na dysku rotowany po rozmiarze; opcjonalny indeks `trace_id -> (plik, offset)` w SQLite dla `trace(trace_id)`.
- Parser ECS: Spring Boot z `LOGGING_STRUCTURED_FORMAT_CONSOLE=ecs` daje JSON z `log.level`, `trace.id`, `error.stack_trace`. Linia niebędąca JSON-em dostaje `level` z heurystyki i trafia do `raw`.
- Maskowanie: zbiór wartości sekretów wstrzykniętych do danego procesu jest znany modułowi `logs` i zamieniany na `***` **przed** zapisem do bufora. Agent i plik widzą już zamaskowaną wersję.
- ANSI usuwane przy zapisie; kolor w UI wynika z `level`.

### 4.3 `services` i `leases`

Serwis to para (repo, task mise `dev`) plus port i sonda. Stany: `stopped`, `starting`, `healthy`, `unhealthy`, `stopping`, `crashed(exitCode, lastStderr)`.

Dzierżawa mówi, **która gałąź/worktree** zajmuje serwis na jego porcie. Domyślnie dzierżawcą jest repo główne. Zadanie agenta, które zmienia kod serwisu, prosi o dzierżawę; daemon zatrzymuje instancję z repo głównego, startuje instancję z worktree zadania na tym samym porcie, a po zakończeniu zadania (lub ręcznie) oddaje. Dzięki temu reszta grafu nie musi niczego wiedzieć. Routing po nagłówku przez proxy jest poza zakresem, dopóki nie pojawi się potrzeba dwóch instancji naraz; interfejs `leases` jest tak pomyślany, żeby proxy dało się dołożyć bez zmiany pozostałych modułów.

### 4.4 `agents`: zadania

- **Adapter CLI** = szablon komendy (`copilot --prompt {prompt_file} ...`), sposób podania konfiguracji MCP, komenda wznowienia sesji, zestaw detektorów stanu. **Jedynym adapterem jest Copilot CLI** (decyzja z 2026-10-23). Interfejs adaptera zostaje, bo porządkuje kod, ale nie projektujemy pod Claude Code ani Codex i nie testujemy ich detektorów.
- Sesja działa w **PTY należącym do daemona** (ConPTY na Windowsie). UI podłącza xterm.js przez WebSocket, `ws attach` robi to samo w terminalu. Wyjście PTY jest nagrywane (format asciicast) do `sessions/<task>.cast`.
- **Wykrywanie stanu**, od najpewniejszego źródła: (1) hooki CLI, jeśli adapter je ma, (2) sekwencje terminala OSC 9 / 777 / 99 oraz komenda `ws notify <state>` dostępna w skryptach agenta, (3) wzorce ekranu (parser VT po stronie daemona, nie w UI). Każda zmiana stanu niesie `source` i `confidence`, więc UI może pokazać „prawdopodobnie czeka na zgodę”.
- Stany: `Working`, `Input`, `Approval`, `Plan`, `Done`, `Error`, plus `Stale` (brak sygnału dłużej niż próg). Budżet czasu i liczby commitów z wymuszonym zakończeniem.
- **Copilot CLI** (ADR-17, prototyp w `modules/agents/` i `scripts/copilot-record.ts`). Daemon podaje sesji **wtyczkę sesji** przez `--plugin-dir`: katalog z `plugin.json` i `hooks.json`, poza worktree i poza `~/.copilot`, więc nie zmienia konfiguracji użytkownika ani plików repo. Hooki to programy uruchamiane bez powłoki (`exec` + `args`) z katalogu wtyczki, nie repo, i z `--no-env-file` (inaczej Bun wczytałby `bunfig.toml` i `.env` z repo użytkownika; potrzebne są oba), które zapisują **rekord hooka** do `hooks.jsonl` sesji: zdarzenie, czas i tylko pola z listy (`CopilotHookPayload`: identyfikator i czas sesji, źródło startu, powód końca, rodzaj i przycięta treść powiadomienia, nazwa narzędzia), a z reszty same nazwy pól, żeby z nagrań poznać nieudokumentowany payload bez zapisywania promptu, argumentów i wyników narzędzi; docelowo zgłoszą go do daemona z tokenem zadania. Zdarzenia i stany: `sessionStart` → `Input`, `userPromptSubmitted` i `postToolUse` → `Working`, `notification` po rodzaju: `permission_prompt` → `Approval`, `elicitation_dialog` → `Input` (rodzaje znalezione w `@github/copilot-sdk` i tekstach Copilot CLI 1.0.103, nie w dokumentacji, więc pewność `medium`); inne rodzaje, m.in. `agent_idle`, `agent_completed` i `shell_completed` o agentach i komendach w tle, nie zmieniają stanu; bez rodzaju `Approval` / `Plan` / `Input` po całych słowach treści z pewnością `low`, `agentStop` → `Input` (koniec tury), `errorOccurred` → `Error`, `sessionEnd` → `Done` albo `Error` po `reason`. Bez `preToolUse` i `permissionRequest`: ich hook, który się wysypie, odmawia agentowi narzędzia, a `permissionRequest` działa także przy zgodzie udzielonej automatycznie, więc nie znaczy „czeka na człowieka”. Z terminala: OSC 9;4 (pasek postępu, domyślne `terminalProgress`) daje `Working` przy stanie 1 lub 3, `Input` z niską pewnością przy zdjęciu paska i `Error` z niską pewnością przy stanie błędu 2; tytuł okna (OSC 0 / 2) to opis bieżącej pracy, nie stan. Wzorców ekranu jeszcze nie ma: powstaną z prawdziwych nagrań, jeśli hooki i OSC okażą się za mało.
- **Łączenie sygnałów** (`TaskStateTracker`): najlepsze źródło, które się odezwało, wygrywa, więc po pierwszym hooku OSC i ekran nie zmieniają stanu, a sesja bez działających hooków dostaje stan z OSC. Wyjątek: słabsze źródło może zakończyć `Working` (np. zdjęcie paska postępu), bo zgubiony hook końca tury zostawiłby sesję w `Working`, a potem w `Stale`, choć czeka na człowieka; zacząć `Working` po hooku już nie może. `Stale` tylko z `Working` po progu bez wyjścia i sygnałów (czekanie na człowieka nie jest zawieszeniem), z czasem progu, a nie chwili sprawdzenia, więc na żywo i z nagrania wychodzi to samo; wyjście przywraca stan sprzed `Stale`. Wyjście procesu jest ostateczne: `Done` przy kodzie 0, `Error` przy innym, chyba że hook `sessionEnd` już zgłosił koniec.
- **Nagranie** `.cast` ma oprócz wyjścia znaczniki (`m`) z rekordami hooków i kodem wyjścia, więc stan da się policzyć jeszcze raz z samego nagrania (`replayCopilotRecording`) tym samym kodem, który działa na żywo. Wejście z klawiatury nie jest nagrywane. Prototyp zapisuje nagranie synchronicznie przy każdym kawałku wyjścia i czyta `hooks.jsonl` co 200 ms; w daemonie z wieloma sesjami zapis musi przejść na asynchroniczny, a rekordy hooków na żądanie HTTP do daemona. Skrypt `copilot-record.ts` sięga do plików modułu wprost, bo `agents` nie ma jeszcze miejsca w fasadzie.
- Worktree per zadanie w `<repo>/.worktrees/<task>`; usunięcie zadania usuwa tylko to, co daemon utworzył. Watcher plików w worktree zasila diff na żywo (Monaco) i listę zmienionych ścieżek, z której wynika ostrzeżenie o konflikcie między zadaniami.

### 4.5 `workspace` i `vcs`: lista repo i przeglądanie

Pierwszy wycinek modułu `workspace` (etap 3 w §11, zrobiony wcześniej na prośbę użytkownika): repo z folderu z projektami i ich przeglądanie, bez klonu, sync i mise.

- **Folder z projektami** (`projectsDir`, ADR-18) to jedyne źródło listy repo. Jego pełna ścieżka jest kluczem `projectsDir` w `workspace.yaml` (ADR-13); ustawia się go w zakładce „Ustawienia” (`set-projects-dir`, katalog musi istnieć) albo ręcznie w pliku. Plik jest czytany przy każdym zapytaniu, więc ręczna edycja działa bez restartu; zapis z UI zmienia tylko ten klucz i zachowuje komentarze oraz pozostałe klucze. Nie ma wartości domyślnej: dopóki folder nie jest ustawiony, lista jest pusta, a UI prowadzi do ustawień.
- **Lista repo** powstaje przy każdym zapytaniu z bezpośrednich podkatalogów folderu, które mają `.git` (katalog albo plik, jak w worktree); katalogi z kropką na początku są pomijane, dowiązanie do katalogu liczy się jak katalog. Głębiej Trackwall nie szuka. Identyfikator repo pochodzi z nazwy katalogu (`orders-bff`; przy kolizji, np. `Zażółć` i `zazolc`, przyrostek `-2` w kolejności po nazwie, więc nowy katalog, który sortuje się wcześniej, przejmuje identyfikator bez przyrostka). Folder jest czytany i sprawdzany przy zapisie asynchronicznie (bywa na dysku sieciowym albo uśpionym dysku zewnętrznym), a stan repo na liście jest pobierany najwyżej dla 8 repo naraz. Repo sklonowane albo usunięte poza Trackwallem pojawia się i znika przy następnym odpytaniu listy; w Trackwallu nie ma ręcznego dodawania ani usuwania. Folder, który zniknął po ustawieniu (np. odłączony dysk), daje błąd `projects_dir_unavailable` z jego ścieżką.
- **Stan repo** (`RepoStatus`) jest obserwowany przy każdym zapytaniu jednym `git status --porcelain=v2 --branch` plus `git log -1`: gałąź, ostatni commit, liczba zmian w katalogu roboczym, ahead/behind względem gałęzi śledzonej. Nic z tego nie jest zapisywane. Repo, którego git nie czyta (uszkodzone `.git`, brak uprawnień), zostaje na liście jako `unavailable` z komunikatem gita.
- **Przeglądanie** czyta z commita HEAD, nie z katalogu roboczego (ADR-14): jedno `cat-file --batch-check` mówi, czy HEAD i `HEAD:<ścieżka>` istnieją, jakiego są typu i rozmiaru, potem `ls-tree` albo `cat-file blob`. Ścieżka z żądania jest ścieżką w drzewie commita, więc nie da się nią wyjść poza repo ani trafić w plik ignorowany przez gita. Podgląd pliku i README jest ucinany do 512 KB; plik z bajtem NUL w pierwszych 8000 bajtach jest binarny (ta sama heurystyka co w gicie).
- **Git** jest uruchamiany przez `spawn` z tablicą argumentów, bez powłoki, z `-C <repo>`, `GIT_CEILING_DIRECTORIES` na katalogu nadrzędnym korzenia repo po rozwinięciu dowiązań (z pustym albo uszkodzonym `.git` git nie szuka repo wyżej i nie pokazuje repo, w którym leży folder z projektami; jawne `--git-dir` wyłączyłoby sprawdzenie właściciela repo, `safe.directory`, więc go nie używamy), `-c core.fsmonitor=false -c log.showSignature=false` (§8), limitem czasu 15 s, `GIT_OPTIONAL_LOCKS=0` (odczyt stanu nie zakłada `index.lock`, gdy użytkownik akurat commituje) i `GIT_TERMINAL_PROMPT=0`, bez odziedziczonych zmiennych wybierających repo (`GIT_DIR`, `GIT_WORK_TREE`…), które przebiłyby `-C`. Wynik jest ustalany bez czekania na zamknięcie rur, bo na Windowsie `git` z `PATH` bywa launcherem, którego wnuk trzyma je po przekroczeniu czasu. Wyjście jest parsowane z formatów maszynowych (`-z`, `--porcelain=v2`), więc nie zależy od języka gita.
- **„Otwórz w VS Code”** otwiera adres `vscode://file/<korzeń repo>` systemowym mechanizmem otwierania URL-i (to samo co `--ui`), bez uruchamiania `code` przez powłokę.
- `workspace.yaml` jest zapisywany przez plik tymczasowy i `rename` (`atomic-write.ts`, wspólne z `daemon.json`), z ponowieniem na Windowsie, gdy plik chwilowo trzyma antywirus albo edytor. Ścieżka folderu z projektami w pliku musi być pełna (na Windowsie z literą dysku albo UNC; `\projekty` zależałaby od bieżącego dysku daemona). Klucz `repos` z wersji 0.2.0 nie jest już czytany, ale zapis go nie usuwa.
- UI odpytuje listę 10 s po poprzedniej odpowiedzi (wolny git nie piętrzy żądań) i tylko przy widocznym oknie; nowy HEAD w liście pobiera przegląd i drzewo od nowa. Zdarzenia na `/ws` zastąpią odpytywanie razem z WebSocketem.

### 4.6 `cards` i `graph`

Karta powstaje w dwóch krokach. Krok deterministyczny czyta pliki repo: `pom.xml` / `build.gradle(.kts)` (artefakty, zależności na klienty Feign/WebClient, konfigurację OpenAPI), `application*.yml` (URL-e, porty, nazwy topików, nazwy zmiennych środowiskowych = kandydaci na sekrety), `package.json` (paczki, skrypty), pliki OpenAPI, definicje Kafki. Ekstraktory są wtyczkami per stack (`extractors/spring`, `extractors/node`), każdy zwraca tylko fakty z pozycją w pliku. Krok LLM dostaje kartę i wybrane fragmenty, zwraca opis i propozycje połączeń, oznaczone `origin: 'llm'`.

Graf = złączenie `consumes` z `provides` po kluczach: URL/base-path, nazwa artefaktu, nazwa topiku, nazwa zmiennej środowiskowej z hostem. Każda krawędź ma `confidence` i `evidence` (plik, linia). Zapytania MCP działają na tym grafie i zwracają identyfikatory z dowodami, nie prozę.

### 4.7 `mise`: taski repo i ich uruchamianie

Pierwszy wycinek modułów `mise` i `procs` (ADR-20): zakładka „Taski mise” w karcie repo pokazuje taski mise repo z folderu z projektami, uruchamia je i zatrzymuje. Serwisy (port, sonda, dzierżawy) i logi to następne kroki.

- **Lista tasków** to `mise tasks ls --json` w korzeniu repo przy każdym zapytaniu (UI odpytuje, gdy zakładka jest otwarta: co 2 s, gdy coś działa, inaczej co 10 s, bo w zaufanym repo mise wykonuje przy tym `[env]`), bez ukrytych (`hide`) i bez nazw, które mise wziąłby za opcję. Brak `mise` w `PATH`, konfiguracja bez zaufania (`untrusted`) i inny błąd mise (np. składnia `mise.toml`) to stany listy, nie błędy API (tak samo przekroczony limit czasu); z komunikatu znikają ostrzeżenia mise (`mise WARN`), które nie są przyczyną. Działający task zostaje do zatrzymania także wtedy, gdy zniknął z konfiguracji albo mise przestał podawać listę (np. błąd w `mise.toml` w trakcie pracy): stan bez listy niesie `running`.
- **Uruchomienie** to `mise run <task>` w korzeniu repo przez `procs`, tylko dla taska z aktualnej listy (§1.2); działający task zwraca swój stan zamiast drugiej grupy. Brak mise przy starcie to `mise_unavailable`, task spoza listy `not_found`.
- **Zaufanie**: mise nie czyta konfiguracji z `[env]`, szablonami albo hookami, dopóki użytkownik jej nie zaufa, a sam `mise run` ufa swojej konfiguracji automatycznie. Akcja `trust` (`mise trust` w korzeniu repo, bez katalogów nadrzędnych) jest tylko w UI, z ostrzeżeniem, że konfiguracja mise może uruchamiać programy (§8).
- Krótkie wywołania `mise` (`tasks ls`, `trust`) idą przez `mise-cli.ts`: tablica argumentów, bez powłoki, limit 15 s i 4 MB wyjścia; nie potrzebują grupy procesów.

## 5. Protokoły

### 5.1 Odkrywanie daemona

Daemon przy starcie zapisuje `~/.trackwall/daemon.json`: `{ pid, port, token, startedAt, version }` z uprawnieniami tylko dla użytkownika. Port jest losowy z zakresu loopback, nasłuch wyłącznie na `127.0.0.1`. Drugi daemon kończy się, gdy `/api/health` istniejącego odpowiada tą samą wersją; przy innej wersji prosi o restart z UI. Klienty (Tauri, `ws`, cienki klient MCP) czytają ten plik, nic nie jest konfigurowane ręcznie.

### 5.2 Daemon ↔ UI i CLI: HTTP + WebSocket

- **HTTP JSON** dla komend i zapytań: `POST /api/<moduł>/<akcja>` z ciałem walidowanym zod z `packages/protocol`. Odpowiedź `{ ok, data }` lub `{ ok: false, error: {code, message} }`. Jedna konwencja dla UI i `ws`. Ciało ma najwyżej 64 KB; puste znaczy `{}`. Akcja jest opisana w `packages/protocol` jednym obiektem `Endpoint` (ścieżka, schemat ciała, schemat `data`): daemon waliduje nim wejście (`api/routes.ts`), a UI typuje ciało i sprawdza odpowiedź, więc obie strony nie mogą ich sparować inaczej. Dziś działają akcje `workspaceApi`: `list` (`{ projectsDir, repos }`), `settings` (`{ projectsDir, configFile }`), `set-projects-dir {path}`, `overview {repo}` (README i 30 commitów), `tree {repo, path}`, `file {repo, path}`, `open-editor {repo}`; `open-editor` zwraca `data: null`. Do tego `miseApi` (§4.7): `tasks {repo}` (`MiseTasks`: lista z `RunState` albo `not_installed` / `untrusted` / `error`), `start {repo, miseTask}` i `stop {repo, miseTask}` (`RunState`; `stop` wraca po potwierdzonym końcu grupy), `trust {repo}`. Komunikaty walidacji są po polsku (`z.locales.pl`). Błąd zgłoszony świadomie przez moduł (`DomainError`) wraca z kodem i treścią: `bad_request` 400, `not_found` 404, `repo_unavailable` 409, `projects_dir_unavailable` 409 (folder z projektami zniknął), `invalid_config` 500 (zły `workspace.yaml`), `mise_unavailable` 409 (brak mise, konfiguracja bez zaufania albo błąd mise przy starcie taska), `stop_unconfirmed` 500 (grupa żyje po zabiciu); każdy inny wyjątek to `internal` bez szczegółów.
- **WebSocket `/ws`** dla zdarzeń: `{ seq, type, payload }`, np. `service.state`, `task.state`, `log.append`, `lease.changed`, `graph.updated`, `sync.progress`. Klient po reconnect wysyła ostatni `seq` i dostaje brakujące zdarzenia z krótkiego bufora lub `resync` z pełnym snapshotem.
- **PTY** jako osobny strumień binarny `/ws/pty/<taskId>`: ramki wejścia, wyjścia i zmiany rozmiaru.
- **Uwierzytelnianie**: token z `daemon.json` w nagłówku `Authorization: Bearer`, porównanie w stałym czasie. Odrzucane są żądania, których `Host` lub `Origin` nie jest loopbackiem (DNS rebinding, CSRF ze strony w przeglądarce). Tauri podaje token do WebView przez komendę Tauri, nie przez query string.

### 5.3 Daemon ↔ agent: MCP

Daemon wystawia serwer MCP w transporcie **Streamable HTTP** pod `/mcp` z tym samym tokenem. Dla CLI, które obsługują tylko stdio, jest cienki klient `trackwall-daemon mcp-stdio`, który przekazuje ramki do `/mcp`. Funkcja „podłącz agenta” w UI dopisuje wpis do konfiguracji MCP danego CLI, nie ruszając reszty pliku.

Narzędzia (wszystkie przyjmują identyfikatory):

| Narzędzie | Wejście | Zwraca |
|---|---|---|
| `who_calls` | `service` lub `endpoint` | krawędzie grafu z dowodami |
| `subgraph_for` | `service`, `depth` | podgraf: węzły, krawędzie, stany serwisów |
| `find_endpoint` | fragment ścieżki / nazwy | kandydaci z repo, plikiem, linią |
| `run_task` | `repo`, `task` ∈ {setup, test, build, lint, health} | `runId`; wynik przez `tail(runId)` |
| `errors` | `service`?, `since_seq`? | rekordy `level>=error` z `next_seq` |
| `trace` | `trace_id` | rekordy ze wszystkich serwisów w kolejności `seq` |
| `tail` | `source`, `since_seq`, `limit` | rekordy, `next_seq`, `dropped` |
| `search` | zapytanie, `source`?, zakres | rekordy z `seq` |
| `required_secrets` | `repo` | nazwy zmiennych z karty |
| `check_secrets` | `repo` | `{name, set: boolean}` bez wartości |

`run_task` nie obejmuje `dev` (start/stop serwisu); tę akcję ma UI i `ws`, agent może o nią poprosić w stanie `Approval`. Każde wywołanie trafia do tabeli `audit` (klient, narzędzie, argumenty, czas, skrót wyniku); audyt jest widoczny tylko w UI.

Zasoby MCP (`resources`) udostępniają kartę repo i aktualny snapshot grafu jako dokumenty tylko do odczytu, żeby agent mógł je wczytać bez serii wywołań.

### 5.4 Tauri ↔ daemon

Tauri uruchamia daemon jako sidecar z argumentem `--parent <pid>`, czeka na `/api/health`, pokazuje ekran powitalny, a po niepowodzeniu dialog z logiem startu. Okno pokazuje się dopiero po załadowaniu UI, z już ustawionym efektem tła (ADR-11). Zamknięcie okna chowa je do traya. „Wyjdź” z traya wysyła `POST /api/daemon/shutdown`, daemon zatrzymuje serwisy i sesje tym samym łagodnym stopem co Ctrl-C, a Tauri czeka na zakończenie. Daemon sam nie kończy się po śmierci rodzica (tryb „działa przy zamkniętym oknie”), ale sprawdza `--parent` tylko po to, żeby odróżnić start z Tauri od ręcznego.

### 5.5 Daemon ↔ scena 3D

`@trackwall/scene` nie ma własnego transportu: dostaje strumień zdarzeń z tego samego WebSocketu co reszta UI i mapuje go na encje koota (`Kind`, `Status`, `Port`, `Lease`, `Layer`). Układ warstw (FE → BFF → serwisy → bazy) wynika z grafu: warstwa = najdłuższa ścieżka od węzłów bez wejść. Render na żądanie po każdej paczce zdarzeń.

## 6. Model danych

Typy żyją w `packages/protocol`. Poniżej rdzeń; pola pomocnicze pominięte.

```ts
type RepoId = string;      // slug z nazwy katalogu w folderze z projektami, np. "orders-bff"
type ServiceId = string;   // zwykle = RepoId; repo może mieć kilka serwisów
type TaskId = string;      // ulid

// Dziś w protocol: { id, path, status: RepoStatus } (§4.5); reszta pól dochodzi z klonem, sync i kartami.
interface Repo {
  id: RepoId; path: string; remote: string; vcs: 'github' | 'gitlab' | 'git';
  defaultBranch: string; head: string;
  analysis?: { commit: string; at: string; cardId: string };
  lastSetup?: RunResult; lastTest?: RunResult;
}

interface RepoCard {
  repo: RepoId; commit: string; stack: ('spring' | 'node' | 'unknown')[];
  provides: Provided[];   // { kind: 'http'|'topic'|'package', key, evidence }
  consumes: Consumed[];   // { kind: 'http'|'topic'|'package'|'env-url', key, evidence }
  runtime: { ports: number[]; databases: string[]; secretNames: string[] };
  description?: { text: string; origin: 'llm'; model: string; at: string };
}

interface Edge { from: ServiceId; to: ServiceId; kind: Consumed['kind']; key: string;
                 confidence: 'exact' | 'high' | 'medium' | 'low'; evidence: Evidence[] }

interface Service {
  id: ServiceId; repo: RepoId; port?: number;
  state: 'stopped'|'starting'|'healthy'|'unhealthy'|'stopping'|'crashed';
  groupId?: string; exitCode?: number; lastStderr?: string;
  lease: Lease;
}

interface Lease { service: ServiceId; holder: { kind: 'main' } | { kind: 'task'; taskId: TaskId };
                  worktree: string; since: string }

// Dziś w kodzie: `RuntimeGroup` w runtime.json (owner jako klucz tekstowy) i `RunState` w protocol (§4.1).
interface ProcessGroup { id: string; leaderPid: number; command: string[]; cwd: string;
                         startedAt: string; owner: { kind: 'service'|'task'|'run'; id: string } }

interface LogRecord { seq: number; ts: string; source: LogSource; stream: 'stdout'|'stderr'|'pty';
                      level: 'trace'|'debug'|'info'|'warn'|'error'; msg: string;
                      traceId?: string; spanId?: string; fields?: Record<string, unknown>; raw: string }

interface Task {
  id: TaskId; title: string; repo: RepoId; branch: string; worktree: string;
  adapter: 'copilot' | 'claude' | 'codex'; prompt: string;
  state: 'Working'|'Input'|'Approval'|'Plan'|'Done'|'Error'|'Stale';
  stateSource: 'hook'|'osc'|'screen'|'timeout'|'exit'; stateConfidence: 'exact'|'high'|'medium'|'low';
  stateSince: string;   // TaskState, TaskStateChange: packages/protocol/src/task-state.ts
  budget: { maxMinutes?: number; maxCommits?: number };
  leases: ServiceId[]; changedPaths: string[]; recording: string;
  summary?: string;   // blok podsumowania z protokołu zakończenia
}

interface AuditEntry { id: number; at: string; client: string; tool: string;
                       args: unknown; durationMs: number; ok: boolean; resultDigest: string }
```

Trwałość: SQLite (`~/.trackwall/trackwall.db`) dla repos, cards, edges (cache), services, leases, tasks, audit; JSONL dla logów; nagrania sesji jako pliki; `runtime.json` tylko dla żywych grup procesów. Konfiguracja workspace to `workspace.yaml` (folder z projektami, nadpisania portów, wskazanie repo sekretów), który użytkownik może trzymać w prywatnym repo; do czasu wyboru katalogu workspace leży w katalogu stanu daemona (ADR-12). Stan nigdy nie miesza się z konfiguracją.

## 7. Przepływy

**Start aplikacji.** Tauri → sidecar → `daemon.json` → `/api/health` → UI ładuje snapshot (`GET /api/snapshot`) i otwiera `/ws` z `seq` ze snapshotu. Daemon przy starcie: sprząta sieroty wg `runtime.json`, odtwarza listę zadań i proponuje wznowienie sesji agentów (komenda wznowienia z adaptera).

**`ws sync`.** Dla każdego repo równolegle (limit współbieżności): fetch, fast-forward gałęzi domyślnej, jeśli `head` ≠ `analysis.commit` to zależności (`mise run setup`) i ekstraktory kart; po wszystkim przeliczenie grafu i zdarzenie `graph.updated`. Repo zmienione lokalnie (brudny worktree) jest pomijane z ostrzeżeniem.

**Uruchomienie serwisu.** UI → `services.start(id)` → `leases.check` → `secrets.resolve(repo)` (git show manifestu `Secret` z gałęzi `origin/<repo>`, klucze z `data` dekodowane z base64, z `stringData` brane wprost, do env) → `mise.run('dev')` przez `procs.spawn` w grupie → `logs` rejestruje źródło i maski → sonda `mise run health` cyklicznie → `service.state`. Awaria: `crashed` z kodem i ostatnią linią stderr na wierszu serwisu, bez restartu w pętli (co najwyżej trzy próby, potem rezygnacja).

**Zadanie agenta.** UI tworzy zadanie (repo, prompt, adapter, budżet) → `vcs.worktree.add` → zapis promptu do pliku → adapter buduje komendę i konfigurację MCP (adres `/mcp`, token zadania) → `procs.spawnPty` → detektory stanu → zdarzenia `task.state` → tray i „skok do czekającego”. Gdy agent zmienia serwis, prosi o dzierżawę (`Approval` w UI lub automatycznie wg ustawienia). Zakończenie: blok podsumowania → `summary`, propozycja PR, oddanie dzierżaw, nagranie zamknięte.

**Błąd cross-repo.** Użytkownik widzi błąd w FE → klika rekord z `trace_id` → `trace(trace_id)` zwraca rekordy z BFF i serwisów w kolejności `seq` → widok osi czasu po serwisach → „utwórz zadanie z tym kontekstem” wkleja do promptu identyfikatory serwisów i zakres `seq`, a agent sam dociąga szczegóły przez MCP.

## 8. Bezpieczeństwo

- Loopback only, token, sprawdzenie `Host`/`Origin`, porównanie w stałym czasie.
- Token zadania (per sesja agenta) zamiast tokenu globalnego: daemon wie, które zadanie woła MCP, może ograniczyć `run_task` do repo zadania i wpisać zadanie do audytu.
- Katalog roboczy procesu zawsze wewnątrz repo lub worktree; ścieżki z wejścia są normalizowane i sprawdzane na wyjście poza korzeń. Przeglądanie repo czyta tylko obiekty z commita HEAD, a ścieżkę w repo waliduje schemat `RepoPath` (bez `.`, `..`, pustych segmentów i znaków sterujących; `\` jest zwykłym znakiem nazwy).
- Daemon uruchamia `git` w każdym podkatalogu folderu z projektami, który ma `.git` (ADR-18), więc na listę trafia też repo, którego użytkownik świadomie nie wybrał (np. rozpakowane archiwum). Konfiguracja repo (`.git/config`) obowiązuje jak w terminalu, z wyjątkiem kluczy, którymi repo kazałoby uruchomić program: daemon wyłącza `core.fsmonitor` (`git status`) i `log.showSignature` (`git log` wołałby `gpg.program`). Komendy daemona (`status`, `log`, `ls-tree`, `cat-file`) nie uruchamiają hooków ani `textconv`, ale `git status` może uruchomić filtr `clean` (np. git-lfs) zdefiniowany w `.git/config` dla ścieżek z `.gitattributes`: to luka, którą zostawiamy, bo wyłączenie filtrów psułoby stan repo z LFS; zamknie ją dopiero lista dozwolonych filtrów albo pytanie użytkownika o zaufanie przy pierwszym repo. Nowa komenda gita w daemonie musi to sprawdzić od nowa.
- Task mise to program z konfiguracji repo: uruchomienie go z UI to zgoda użytkownika na wykonanie kodu repo, tak jak `mise run` w terminalu. Daemon uruchamia tylko task z aktualnej listy `mise tasks ls`, w korzeniu repo, bez powłoki po stronie daemona; samą listę mise odmawia podać dla konfiguracji bez zaufania. `mise trust` (akcja `trust`) jest tylko w UI i dotyczy tylko konfiguracji w korzeniu repo. Na macOS daemon raz uruchamia interaktywną powłokę logowania użytkownika (`$SHELL -ilc`), żeby poznać `PATH`, więc wykonuje jego pliki startowe powłoki, jak każdy nowy terminal.
- Sprzątanie sierot ufa `runtime.json` w katalogu stanu; proces użytkownika, który zapisze tam cudzy PID, i tak może zabić ten proces sam. Grupa, której lider nie żyje, jest zabijana bez sprawdzenia czasu startu: wyjątkiem byłby nowy proces z tym samym PID-em, który sam założył sesję, a potem zakończył się, zostawiając w niej potomków.
- Pod Node na Windowsie (tryb zgodności, ADR-20) grupa to drzewo z `taskkill /T`: pusta grupa znaczy tylko „lider nie żyje”, potomek osierocony przez wcześniejszą śmierć rodzica wypada z drzewa i przeżywa stop, a po twardym zabiciu daemona nic nie jest sprzątane (żywy PID z `runtime.json` trafia tylko do logu). Wydanie jest binarką Bun z Job Object, więc luka dotyczy uruchomienia ze źródeł pod Node.
- Krótkie zapytania do `mise` (`tasks ls`, `trust`) idą poza `procs`, jak `git`: po przekroczeniu limitu daemon kończy sam `mise`, a program uruchomiony przez mise z `[env]` zaufanej konfiguracji może przeżyć.
- Klon repo sekretów poza workspace, w katalogu niewidocznym dla worktree; w profilu zadania repo sekretów jest wykluczone z narzędzi plikowych agenta (konfiguracja adaptera).
- Zmienne środowiskowe nigdy nie trafiają do logów ani do audytu; maskowanie wartości przed buforem.
- Stan zadania z hooków i OSC pochodzi od procesu sesji, więc sesja może go sfałszować (dopisać rekord do `hooks.jsonl`, wypisać OSC 9;4). Stan jest tylko informacją dla człowieka i nie daje sesji żadnego uprawnienia; tak ma zostać. Rekord hooka zapisuje tylko pola z listy (bez promptu, argumentów i wyników narzędzi), a payload hooka jest parsowany schematem jak każde wejście z zewnątrz. Wyjątki, o których trzeba pamiętać przy fixture'ach: przycięta treść powiadomienia (może zawierać komendę, o którą agent prosi) i tytuł okna w `states.jsonl` (opis bieżącej pracy), a nagranie `.cast` ma cały ekran sesji.
- Autostart i „podłącz agenta” tylko z UI; agent nie ma narzędzia do zmiany konfiguracji daemona.
- Jeśli kiedyś pojawią się narzędzia bazodanowe, rola bez superużytkownika i transakcja tylko do odczytu.
- Podatności zgłasza się prywatnie według `SECURITY.md` (GitHub Security Advisories).

## 9. Windows: ryzyka i jak je sprawdzamy wcześnie

| Ryzyko | Co może pójść źle | Jak sprawdzamy |
|---|---|---|
| Job Objects z Bun/Node | brak natywnego API; trzeba N-API lub `koffi`; proces potomny już w innym jobie (np. uruchomiony z terminala VS Code) nie da się dodać bez `JOB_OBJECT_LIMIT_BREAKAWAY_OK`; pod Node (bez FFI) grupą jest drzewo z `taskkill /T`, z którego wypada potomek po śmierci rodzica, a sieroty po twardym zabiciu daemona zostają | spike w etapie 1: moduł `procs` z testem „zabij drzewo mise→mvn→java” |
| ConPTY + `node-pty` w Bun | natywny addon może nie działać pod Bun; `bun build --compile` nie osadza `.node` | spike w etapie 1; plan B: Node 22 + SEA, plan C: PTY po stronie Rust w Tauri (`portable-pty`) z mostem do daemona |
| Łagodny stop na Windowsie | brak SIGTERM; `GenerateConsoleCtrlEvent` wymaga wspólnej konsoli; `taskkill` zgłasza sukces przy żywym procesie | stop zawsze potwierdzany obserwacją; dla Spring Boot dodatkowo `POST /actuator/shutdown`, jeśli włączone |
| Wykrywanie stanu Copilot CLI | hooki z `--plugin-dir` nie startują na Windowsie (ścieżka `exec`, AppData), ConPTY gubi lub przestawia OSC 9;4; ekran ConPTY różni się od Unixa; `Bun.spawn({ terminal })` jest w dokumentacji Bun opisany jako tylko POSIX, choć spike z etapu 1 przeszedł na Windowsie (ADR-1) | etap 2 (ADR-17): `copilot-record.ts` na prawdziwym Windowsie i macOS według listy w opisie PR; wzorce ekranu tylko z nagrań, jeśli hooki i OSC nie wystarczą |
| Portable exe | WebView2 może nie być zainstalowany; SmartScreen blokuje niepodpisany plik; autoaktualizacja musi podmienić działający plik | etap 1: build z `tauri.conf` → bundle `none` + sprawdzenie WebView2 przy starcie; test na prawdziwym Windowsie; podpis Azure Trusted Signing przed publikacją |
| Długie ścieżki i blokady plików | worktree pod `.worktrees` przekracza 260 znaków; `git worktree remove` nie usuwa plików trzymanych przez proces | `\\?\` i `core.longpaths`; usuwanie worktree dopiero po potwierdzonym stopie grupy |
| Port → właściciel | `netstat`/`Get-NetTCPConnection` wolne; PID bez drzewa | `GetExtendedTcpTable` przez N-API, drzewo z `runtime.json` i Job Object |
| Antywirus / EDR | losowe spowolnienia, kwarantanna daemona | portable bez pakowania UPX, wczesny test na prawdziwym Windowsie |

## 10. Testy i CI

- `procs` i `logs`: testy integracyjne uruchamiające prawdziwe procesy potomne (skrypt, który odpala wnuka i ignoruje łagodny stop), na obu systemach w macierzy CI (push na `main` albo ręcznie, ADR-15).
- `cards`: testy na fixture'ach repo (małe pom.xml, application.yml, package.json) bez sieci.
- `agents`: detektory stanu testowane na nagraniach `.cast` odtwarzanych przez `replayCopilotRecording`; nagrania z prawdziwych sesji Copilot CLI trafiają do repo jako fixture'y dopiero po anonimizacji. Do tego czasu fixture jest syntetyczny (`test/fixtures/copilot/`, oznaczony w tytule nagrania), a pełną ścieżkę (PTY, wtyczka sesji, procesy hooków, nagranie) sprawdza test z atrapą Copilot CLI.
- `api`/`mcp`: kontrakt z `packages/protocol`, testy przez prawdziwy klient MCP SDK.
- CI (ADR-15): każdy PR i push na `main` przechodzi lint, `cargo fmt`, typecheck i testy na `ubuntu-latest` oraz audyt zależności. Push na `main` i ręczne uruchomienie (`workflow_dispatch`, także na gałęzi PR) dokładają po zielonym Linuksie job `desktop` na `windows-latest` i `macos-latest`: test → build daemona (binarka) → build Tauri portable → artefakty → spike'i. Zmiany tylko w Markdownie i `docs/` nie uruchamiają CI, a nowy push przerywa poprzedni przebieg tej gałęzi, także na `main`. Wydanie z tagu (`release.yml`): GitHub Release powstaje dopiero po przejściu obu buildów, opis w `docs/release.md`.

## 11. Kamienie milowe (mapowanie na kolejność prac)

1. **Szkielet**: monorepo, `protocol`, daemon z `/api/health`, UI z jednym panelem, Tauri portable na Win i mac, CI. Spike'i: Job Objects, ConPTY/node-pty pod Bun. Wynik: decyzja Bun vs Node (ADR-1 potwierdzony lub odwrócony).
2. **Prototyp Copilot CLI**: PTY w daemonie, xterm w UI, detektory stanu, test na prawdziwym Windowsie. Wynik: które źródła stanu działają i z jaką pewnością. Zrobione: detektory z hooków i OSC 9;4, łączenie sygnałów, nagrywanie i odtwarzanie (ADR-17). Zostało: wyniki z prawdziwego Windowsa i macOS, potem PTY w module `procs`, `/ws/pty/<taskId>` i xterm w UI.
3. **Workspace**: `workspace.yaml`, sync, generator mise, `procs` + `logs` w pełni, zakładka Serwisy i Zadania, `ws` CLI. Zrobione: folder z projektami (ADR-18), taski mise w karcie repo z grupami procesów (ADR-20).
4. **Wiedza**: ekstraktory kart, graf, serwer MCP z narzędziami z §5.3, audyt.
5. **Dopełnienie**: scena 3D, dzierżawy, `trace`, sekrety w wersji docelowej (sops + age).

## 12. Decyzje (ADR w skrócie)

**ADR-1 Runtime daemona: Bun, z zachowaniem zgodności z Node.** Bun daje `bun build --compile` do jednej binarki i wbudowane SQLite. Kod pisany tak, by działał też pod Node 22 (`node:` API, bez API specyficznych dla Bun poza warstwą `platform/`). Jeśli spike z etapu 1 pokaże, że ConPTY lub Job Objects nie działają pod Bun, przechodzimy na Node 22 + SEA bez zmian w modułach. Uzupełnienie (2026-10-23): zgodności z Node pilnuje narzędzie, bo bez tego się rozjechała (właściwość w parametrze konstruktora w `api/guard.ts` blokowała start pod Node). Daemon i `protocol` mają `erasableSyntaxOnly` i wymagane rozszerzenia w importach, API Bun poza `platform/` odrzuca Biome, a testy procesu daemona idą pod Bun i pod Node z flagami ze skryptu `start:node` (Node 22.12+ uruchamia kod źródłowy bez kompilacji). Wynik spike'ów z etapu 1 (Bun 1.4.2, Windows x64, macOS arm64, Linux, także w binarce z `--compile` przeniesionej poza repo): Job Objects przez `bun:ffi` działają na Windowsie, grupa procesów (`setsid` + `kill(-pgid)`) na macOS; PTY dają `bun-pty` i `Bun.spawn({ terminal })` (na Windowsie ConPTY), a `node-pty` pod Bun nie działa i nie ładuje `.node` w `--compile`. ADR-1 jest więc potwierdzony.

**ADR-2 Transport UI: HTTP + WebSocket, nie tylko IPC Tauri.** Dzięki temu ten sam UI działa w przeglądarce (etap 1) i w Tauri, a `ws` CLI i testy używają tego samego API. Tauri IPC zostaje dla spraw natywnych: tray, autostart, token.

**ADR-3 MCP w daemonie, transport Streamable HTTP, stdio jako most.** Jeden proces trzyma stan, więc narzędzia MCP nie potrzebują osobnego kanału. Most stdio dla CLI, które HTTP nie obsługują.

**ADR-4 Trwałość: SQLite + JSONL, bez zewnętrznej bazy.** Jedna osoba, jedna maszyna; SQLite wystarcza, a JSONL jest czytelny ręcznie i tani w zapisie.

**ADR-5 Dzierżawy zamiast proxy.** Jedna instancja serwisu na porcie i przejęcie przez zadanie rozwiązuje 90% przypadków bez proxy; interfejs `leases` zostawia miejsce na routing po nagłówku.

**ADR-6 Fakty z ekstraktorów, LLM tylko w polu `description` i w propozycjach z `origin: 'llm'`.** Powtarzalność analizy i możliwość testów bez modelu.

**ADR-7 Nic firmowego w repo.** Wszystkie reguły specyficzne dla firmy (wzorce URL, nazwy topików, adapter GitLab z adresem instancji) są konfiguracją workspace, a ekstraktory przyjmują je jako parametry.

**ADR-8 Tylko Copilot CLI.** (2026-10-23) Jeden adapter agenta. Abstrakcja adaptera zostaje jako granica w kodzie, ale nie jest rozwijana pod inne CLI.

**ADR-9 Bez auto-merge i plannera, na stałe.** (2026-10-23) Zadanie kończy się podsumowaniem i propozycją PR; łączenie i rozbijanie celów robi człowiek. W modelu danych nie ma miejsca na zależności między zadaniami ani kolejkę.

**ADR-10 Repo sekretów trzyma manifesty k8s `Secret`.** (2026-10-23) Gałąź `origin/<repo>` zawiera pliki YAML `kind: Secret`; `secrets.resolve` czyta `data` (base64) i `stringData` (jawny tekst) i mapuje klucze na zmienne środowiskowe 1:1. Nazwy kluczy są porównywane z `runtime.secretNames` z karty repo, stąd `check_secrets`. Docelowe szyfrowanie sops + age nie zmienia formatu, tylko dodaje krok odszyfrowania przed parsowaniem.

**ADR-11 Półprzezroczyste okno z efektem systemowym, nieprzezroczyste tło jako fallback.** (2026-10-23) Okno Tauri jest przezroczyste (`transparent`, motyw `Dark`), a powłoka w `setup` próbuje efektów po kolei przez `window-vibrancy`: na Windows Mica (Windows 11), potem Acrylic (Windows 10 1809+), na macOS vibrancy `UnderWindowBackground`. Po załadowaniu strony powłoka ustawia na `<html>` atrybut `data-window-effect` z nazwą przyjętego efektu i pokazuje okno (startuje z `visible: false`) dopiero po wykonaniu tego skryptu, więc przy starcie nie miga nieprzezroczyste tło; gdyby strona nie zgłosiła końca ładowania, okno pokazuje się po 10 s. Odświeżenie strony (F5) maluje ją nieprzezroczyście do końca ładowania, co zostawiamy jako rzadki przypadek. Atrybut zdejmuje tło strony i robi powierzchnie półprzezroczystymi; bez niego (brak efektu, przeglądarka) UI zostaje nieprzezroczyste, a `prefers-reduced-transparency` przywraca nieprzezroczystość także przy działającym efekcie. `set_effects` z Tauri odpada, bo bierze tylko pierwszy efekt z listy i nie mówi, czy się udał. `macOSPrivateApi` nie jest potrzebne: od Tauri 2.12.1 (dolna granica w `Cargo.toml`) przezroczystość na macOS działa bez tej flagi. Odwróciłoby to zauważalne przycinanie Acrylic przy przeciąganiu okna na Windows 10 (wtedy Windows 10 dostaje nieprzezroczyste tło) albo słaba czytelność na jasnych tapetach (wtedy mniejsza przezroczystość powierzchni).

**ADR-12 Nazwa: Trackwall.** (2026-10-23) Robocza nazwa „Pitwall” była zajęta przez istniejące narzędzia deweloperskie (quanticstudios/pitwall, aenzenith/pitwall-vscode), więc projekt nazywa się Trackwall: paczki `@trackwall/*`, binarki `trackwall` i `trackwall-daemon`, katalog danych `~/.trackwall`, zmienne `TRACKWALL_*`, identyfikator aplikacji `dev.trackwall.desktop`. Nazwa zostaje przy motywie ściany przy torze i w chwili decyzji była wolna na npm (także jako scope), crates.io i PyPI. Stan z wersji 0.1.0 w `~/.pitwall` nie jest przenoszony, bo poza tokenem i logami nic tam nie ma. Odwróciłaby ją kolizja nazwy z narzędziem lub znakiem towarowym znaleziona przed publikacją.

**ADR-13 `workspace.yaml` w katalogu stanu daemona, do czasu wyboru workspace.** (2026-10-23) Lista repo (od ADR-18: folder z projektami) jest w `<katalog stanu>/workspace.yaml` (`~/.trackwall/workspace.yaml`). Dzięki temu pierwsza wersja nie potrzebuje ekranu wyboru workspace, a plik ma już docelowy format i można go przenieść. Odwróci to wybór katalogu workspace w UI (np. prywatne repo z konfiguracją): wtedy daemon dostaje ścieżkę do pliku, a w katalogu stanu zostaje tylko wskazanie na niego. Ręczna lista `repos` w tym pliku zastąpiona przez ADR-18; położenie pliku obowiązuje dalej.

**ADR-14 Przeglądanie repo z commita HEAD, nie z katalogu roboczego.** (2026-10-23) Drzewo plików, README i podgląd czytają obiekty gita (`ls-tree`, `cat-file`). Ścieżka z UI nie dotyka systemu plików, więc nie ma ryzyka wyjścia poza repo, dowiązań symbolicznych, plików zablokowanych przez procesy ani przypadkowego pokazania sekretów z ignorowanych plików (`.env`). Kosztem jest to, że niezacommitowanych zmian w przeglądarce nie widać; pokazuje je liczba zmian w stanie repo, a docelowo diff (Monaco). Odwróci to potrzeba edycji plików w UI albo podglądu katalogu roboczego; wtedy osobna trasa z walidacją ścieżki względem korzenia.

**ADR-15 CI przy PR tylko na Linuksie, Windows i macOS na `main`, ręcznie i przy wydaniu.** (2026-10-23) W prywatnym repo minuta runnera Windows liczy się w limicie GitHub Actions podwójnie, a macOS dziesięciokrotnie, a pełna macierz przy każdym PR i pushu wyczerpała limit. Błąd specyficzny dla systemu w PR bez ręcznego przebiegu wychodzi najpóźniej na `main`, a wydanie (`release.yml`) uruchamia testy na obu systemach przed publikacją. Odwróci to upublicznienie repo (standardowe runnery są wtedy bez limitu) albo własny runner: wtedy macierz Windows + macOS wraca do każdego PR.

**ADR-16 Wygląd UI: jeden ciemny motyw HUD z jednym akcentem, tokeny tylko w `index.css`.** (2026-10-23) UI ma jeden motyw, ciemny, w duchu HUD-a: czarne tło (to samo co `ACRYLIC_TINT`, więc ADR-11 działa bez zmian w powłoce), chłodne szklane powierzchnie z cienkimi liniami i siatką pod treścią, cyjan jako jedyny akcent dla tego, co aktywne, a zielony, bursztynowy i czerwony wyłącznie dla stanu (`success`, `warning`, `destructive`). Wszystkie tokeny są w `packages/ui/src/index.css`: kolory w `:root`, w `@theme` kroje, rozmiar `text-2xs`, rozstrzelenie liter `tracking-hud`/`tracking-brand`, wymiary `--spacing-header` (`h-header`) i `--spacing-sidebar`, poświaty `shadow-glow-*`, oraz narzędzia `surface`, `hud-label` (etykiety sekcji i pól, mono wersalikami; nie dla zdań), `hud-grid` i `hud-active-edge`. Komponenty używają tylko tokenów, a test `packages/ui/test/design-tokens.test.ts` odrzuca surowe kolory i dowolne wartości wyglądu w `.tsx`. Pozostałe odstępy to skala Tailwinda. Wspólne klocki: `Surface` (powierzchnia z nagłówkiem i przypisem), `StatusLabel` (kropka stanu z tekstem; ton z `repoStatusTone`), `Loading` i komponenty shadcn/ui w `components/ui`. Fonty są systemowe (Segoe UI Variable i Cascadia Mono na Windowsie, SF na macOS), bo aplikacja działa offline i nie chcemy dokładać plików fontów. Kierunek pochodzi z inspiracji dla grafu i sceny 3D (etap 5), żeby reszta UI do nich pasowała; główny widok ze sceną lub grafem ma mieć układ „scena na całą szerokość, szczegóły wybranego węzła w panelu po prawej”. Odwróciłaby to słaba czytelność na prawdziwym Windowsie z Mica/Acrylic albo potrzeba jasnego motywu; wtedy drugi zestaw kolorów pod klasą i przełącznik.

**ADR-17 Stan Copilot CLI z hooków wtyczki sesji, OSC 9;4 jako zapas, bez parsera ekranu na start.** (2026-10-23) Copilot CLI ma według dokumentacji hooki dla końca tury (`agentStop`), powiadomień (`notification`, w tym prośby o zgodę), błędów i końca sesji, a wtyczka podana przez `--plugin-dir` ładuje je tylko dla jednej sesji, bez zmian w `~/.copilot` i bez plików w repo. Na Copilot CLI 1.0.103 (Linux) sprawdzone: `copilot plugin list` pokazuje taką wtyczkę, a jej hook `sessionEnd` z `exec` + `args` odpalił się już na ekranie zaufania folderu, przed logowaniem; reszty zdarzeń bez zalogowanego konta nie dało się wywołać. Hook to program z `exec` + `args`, bez powłoki, więc ta sama definicja działa na Windowsie i macOS. Pasek postępu OSC 9;4 Copilot CLI wysyła domyślnie, więc daje `Working` także wtedy, gdy hooki nie działają. Parser ekranu (VT w daemonie) odkładamy, bo wymaga zależności i wzorców, których bez nagrań nie da się sprawdzić. Rozważony tryb `copilot --acp` (Agent Client Protocol: JSON-RPC na stdio z dokładnym stanem i prośbami o zgodę) odpada na teraz, bo zastępuje TUI Copilot CLI własnym widokiem rozmowy w UI; wraca, jeśli hooki okażą się zawodne albo UI i tak dostanie własny widok sesji. Inne źródła odrzucone: `copilot -p --output-format json` daje zdarzenia JSONL, ale tylko bez TUI i z `--allow-all-tools`, więc nie ma w nim stanu `Approval` ani rozmowy z człowiekiem; katalog `~/.copilot/session-state/<sesja>/` i logi w `~/.copilot/logs` mają nieudokumentowany, wewnętrzny format, który może zmienić się z każdą wersją. Odwróciłoby to: hooki z `--plugin-dir` niedziałające na Windowsie (wtedy wtyczka w `.github/hooks` worktree wykluczona przez `.git/info/exclude`), hooki działające tylko częściowo, np. bez `notification` (po pierwszym hooku OSC może już tylko zakończyć `Working`, więc wtedy reguła łączenia per zdarzenie albo wzorce ekranu), albo rodzaje `notification` niedające odróżnić zgody od pytania (wtedy wzorce ekranu dla `Approval`). PTY w prototypie daje `Bun.spawn({ terminal })` (ADR-1); gdyby nie działał w ConPTY, wraca `bun-pty` ze spike'a.

**ADR-18 Lista repo to repo gita w folderze z projektami, nie ręczna lista.** (2026-10-23) `workspace.yaml` wskazuje jeden folder (`projectsDir`), a lista repo to jego bezpośrednie podkatalogi z `.git`, odczytywane przy każdym zapytaniu. Tak użytkownik i tak trzyma repo (jeden folder z klonami), więc konfiguracja to jedna ścieżka zamiast listy, a repo sklonowane z terminala albo usunięte z dysku nie rozjeżdża się z Trackwallem. Ten sam model obsłuży dodawanie repo przez wybór z listy dostępnych w GitHub albo GitLab: klon trafia do folderu i od razu jest na liście, bez osobnego zapisu. Ręczne dodawanie ścieżką i usuwanie z listy znikają; identyfikator repo zależy teraz od nazwy katalogu, więc zmiana nazwy katalogu zmienia identyfikator, a nowy katalog o kolidującej nazwie, który sortuje się wcześniej, może przejąć identyfikator istniejącego repo (dziś nic go nie zapisuje; tabele `tasks` i `cards` z §6 będą musiały zapisywać też ścieżkę). Skan tylko na jeden poziom, bo zagnieżdżone repo (submoduły, przykłady w repo) dawałyby fałszywe wpisy, a skan całego drzewa jest drogi przy `node_modules`. Odwróciłyby to: potrzeba repo spoza folderu (wtedy dodatkowa lista `extraRepos` obok `projectsDir`), układ folderu z grupami jak w GitLab (`<grupa>/<repo>`, wtedy głębokość skanu w konfiguracji) albo kilka folderów naraz (`projectsDir` jako lista).

**ADR-20 Grupa procesów: Job Object pod Bun na Windowsie, sesja POSIX na macOS, bez Effect i bez natywnego addonu.** (2026-10-23) Moduł `procs` uruchamia każdy task mise jako grupę: na Windowsie Job Object z `KILL_ON_JOB_CLOSE` przez `bun:ffi` (spike z etapu 1, ADR-1), na macOS i Linuksie `setsid` i sygnały do `-pgid`; stan `exited` i sukces stopu dopiero po potwierdzeniu w systemie, że grupa jest pusta. Kod systemowy siedzi w `platform/` za interfejsem `GroupPlatform`, więc moduł nie zależy od Bun. Pod Node na Windowsie nie ma FFI: grupą jest drzewo z `taskkill /T /F`, bez sprzątania sierot; Node to tryb zgodności (ADR-1), a wydanie jest binarką Bun. Łagodny stop na Windowsie to zamknięcie stdin, bo Ctrl+C wymaga wspólnej konsoli. Sieroty na macOS sprząta następny start daemona według `runtime.json` z czasem startu lidera z `ps`. Effect (anulowanie, zasoby, limity czasu jako biblioteka) rozważony i odłożony: przebieg stopu to kilka kroków z limitami czasu, które czyta się wprost, a Effect zmieniłby styl całego daemona, więc to osobna decyzja. Interfejs `ProcessGroups` (obietnice) da się później owinąć bez zmian w `platform/`. Odwróciłyby to: lider uciekający z joba przed przypisaniem (wtedy start wstrzymany przez `CreateProcessW` z `CREATE_SUSPENDED` w FFI), serwery na Windowsie, które wymagają Ctrl+C do czystego zamknięcia (wtedy osobna konsola i `GenerateConsoleCtrlEvent`), albo wydanie pod Node (wtedy Job Object przez natywny addon).

## 13. Pytania otwarte

Wszystkie pytania z wizji zostały rozstrzygnięte 2026-10-23 (ADR-8, ADR-9, ADR-10).
