# Architektura Pitwall

Stan: propozycja do dyskusji, 2026-10-23. Nazwa „Pitwall” jest robocza (zajęta przez quanticstudios/pitwall i aenzenith/pitwall-vscode) i zostanie zmieniona przed publikacją.

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
│  scena 3D: @pitwall/scene (Pawn)          │  workspace  cards  │ │
│      │ HTTP + WebSocket (loopback, token)  │  graph      tasks  │ │
│      └────────────────────────────────────▶│  procs      leases │ │
│                                            │  logs       secrets│ │
│   CLI `ws` ──────── HTTP (loopback) ──────▶│  agents     audit  │ │
│                                            └───┬──────────┬─────┘ │
│   Copilot CLI / inne CLI ── MCP (HTTP lub stdio) ─┘          │     │
│                                                   SQLite + JSONL   │
│                                                   ~/.pitwall/      │
└──────────────────────────────────────────────────────────────────┘
```

Cztery procesy na maszynie użytkownika:

| Proces | Rola | Żyje, gdy okno zamknięte? |
|---|---|---|
| `pitwall.exe` (Tauri) | okno, tray, nadzór daemona, aktualizacja | tak, w trayu |
| `pitwall-daemon.exe` (sidecar) | cała logika: workspace, procesy, logi, zadania, MCP | tak |
| procesy serwisów | `mise run dev` w grupie procesów per serwis | tak |
| sesje agentów | CLI agenta w PTY należącym do daemona | tak |

Daemon można też uruchomić bez Tauri (`pitwall-daemon --ui`), co daje tryb „lokalna strona w przeglądarce” z pierwszego etapu prac. Tauri niczego nie dodaje do logiki, tylko do pakowania i integracji z systemem.

## 3. Monorepo

```
pitwall/
  package.json            pnpm workspaces, skrypty root
  pnpm-workspace.yaml
  mise.toml               wersje narzędzi dla samego projektu (node/bun, pnpm, rust)
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
    adr/                  decyzje architektoniczne (od chwili, gdy zacznie ich przybywać)
  .github/workflows/
    ci.yml                macierz windows-latest + macos-latest: lint, test, build portable
```

`packages/protocol` jest jedyną zależnością wspólną między daemonem, UI, sceną i CLI. Dzięki temu UI nie importuje nic z daemona (nie da się przypadkiem wciągnąć `node:child_process` do bundle'a WebView), a schematy zod są jednocześnie walidacją wejścia w daemonie i typami w UI.

## 4. Daemon: moduły i granice

Daemon jest jednym procesem, ale wewnątrz jest podzielony na moduły z jawnie zadeklarowanym interfejsem. Każdy moduł wystawia klasę serwisu, a fasada (`Facade`) jest po prostu zbiorem tych serwisów przekazanym do trzech transportów (HTTP, MCP, zdarzenia). Moduł nie importuje innego modułu bezpośrednio, tylko przez fasadę, więc graf zależności między modułami jest widoczny w jednym pliku.

| Moduł | Odpowiada za | Zależy od | Trwały stan |
|---|---|---|---|
| `workspace` | lista repo, klon, sync, stan per repo, `ws sync` | `vcs`, `tasks(mise)` | `workspace.yaml`, tabela `repos` |
| `vcs` | adaptery git (lokalne), GitHub, GitLab; worktree; `git show` bez checkoutu | – | – |
| `mise` | generowanie `mise.local.toml`, uruchamianie tasków po nazwie, wykrywanie stacku | `procs` | pliki w repo |
| `cards` | analiza repo -> karta (provides / consumes / runtime); uzupełnienie przez LLM | `workspace` | tabela `cards` z commitem analizy |
| `graph` | złączenie kart w graf; zapytania `who_calls`, `subgraph_for`, `find_endpoint` | `cards` | liczony w pamięci, cache w SQLite |
| `procs` | grupy procesów, start/stop z eskalacją, sieroty, port -> właściciel | – | `runtime.json` (grupy żywe) |
| `logs` | magistrala: ring buffer, JSONL, sekwencje, kursory, maskowanie, `trace` | `secrets` (maski) | `logs/<repo>/<proces>.jsonl` |
| `services` | serwis = repo + task `dev` + port + sonda; dzierżawy | `procs`, `mise`, `logs`, `leases` | tabela `services` |
| `leases` | kto trzyma serwis na jakim porcie; przejęcie przez zadanie | – | tabela `leases` |
| `secrets` | repo sekretów (manifesty k8s `Secret`), odczyt `git show origin/<app>:<plik>`, wstrzyknięcie do env, `check_secrets` | `vcs` | klon poza workspace |
| `agents` | adaptery CLI, PTY, wykrywanie stanu, worktree per zadanie, budżet, nagrywanie | `vcs`, `procs`, `logs`, `leases` | tabela `tasks`, nagrania `sessions/` |
| `mcp` | serwer MCP: mapowanie narzędzi na fasadę, audyt | wszystko przez fasadę | tabela `audit` |
| `api` | HTTP + WebSocket dla UI i CLI, token, CORS, statyczne pliki UI | wszystko przez fasadę | – |

Dwa moduły są „fundamentem”: `procs` i `logs`. Nie zależą od niczego i wszystko inne na nich stoi, więc powstają najpierw i dostają najwięcej testów, w tym na Windowsie.

### 4.1 `procs`: grupy procesów

- Start zawsze tworzy **grupę**: na Windowsie Job Object z `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, na macOS nowa sesja (`setsid`) i zabijanie po `-pgid`. Dziecko mise, które odpala mvn, który odpala javę, jest jedną jednostką.
- Stop eskaluje: łagodny sygnał (Windows: `GenerateConsoleCtrlEvent` lub zamknięcie stdin, w zależności od stacku), po czasie łaski zakończenie całej grupy. **Stop zwraca sukces dopiero po potwierdzeniu**, że żaden proces grupy nie żyje i port został zwolniony.
- Rejestr grup w `runtime.json`: lider, komenda, czas startu. Przy starcie daemona sieroty są sprzątane tylko, gdy komenda i czas startu lidera się zgadzają (PID-y są recyklingowane).
- stdout i stderr są zawsze czytane (nieczytany pipe blokuje dziecko przy ok. 64–192 KB) i trafiają do `logs`.
- `portOwner(port)` zwraca właściciela z poziomem pewności: `exact` (PID z naszej grupy), `high` (potomek naszej grupy), `medium` (komenda pasuje do serwisu), `low`. Przy `low` daemon nie podejmuje akcji automatycznie.

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
- Worktree per zadanie w `<repo>/.worktrees/<task>`; usunięcie zadania usuwa tylko to, co daemon utworzył. Watcher plików w worktree zasila diff na żywo (Monaco) i listę zmienionych ścieżek, z której wynika ostrzeżenie o konflikcie między zadaniami.

### 4.5 `cards` i `graph`

Karta powstaje w dwóch krokach. Krok deterministyczny czyta pliki repo: `pom.xml` / `build.gradle(.kts)` (artefakty, zależności na klienty Feign/WebClient, konfigurację OpenAPI), `application*.yml` (URL-e, porty, nazwy topików, nazwy zmiennych środowiskowych = kandydaci na sekrety), `package.json` (paczki, skrypty), pliki OpenAPI, definicje Kafki. Ekstraktory są wtyczkami per stack (`extractors/spring`, `extractors/node`), każdy zwraca tylko fakty z pozycją w pliku. Krok LLM dostaje kartę i wybrane fragmenty, zwraca opis i propozycje połączeń, oznaczone `origin: 'llm'`.

Graf = złączenie `consumes` z `provides` po kluczach: URL/base-path, nazwa artefaktu, nazwa topiku, nazwa zmiennej środowiskowej z hostem. Każda krawędź ma `confidence` i `evidence` (plik, linia). Zapytania MCP działają na tym grafie i zwracają identyfikatory z dowodami, nie prozę.

## 5. Protokoły

### 5.1 Odkrywanie daemona

Daemon przy starcie zapisuje `~/.pitwall/daemon.json`: `{ pid, port, token, startedAt, version }` z uprawnieniami tylko dla użytkownika. Port jest losowy z zakresu loopback, nasłuch wyłącznie na `127.0.0.1`. Drugi daemon kończy się, gdy `/api/health` istniejącego odpowiada tą samą wersją; przy innej wersji prosi o restart z UI. Klienty (Tauri, `ws`, cienki klient MCP) czytają ten plik, nic nie jest konfigurowane ręcznie.

### 5.2 Daemon ↔ UI i CLI: HTTP + WebSocket

- **HTTP JSON** dla komend i zapytań: `POST /api/<moduł>/<akcja>` z ciałem walidowanym zod z `packages/protocol`. Odpowiedź `{ ok, data }` lub `{ ok: false, error: {code, message} }`. Jedna konwencja dla UI i `ws`.
- **WebSocket `/ws`** dla zdarzeń: `{ seq, type, payload }`, np. `service.state`, `task.state`, `log.append`, `lease.changed`, `graph.updated`, `sync.progress`. Klient po reconnect wysyła ostatni `seq` i dostaje brakujące zdarzenia z krótkiego bufora lub `resync` z pełnym snapshotem.
- **PTY** jako osobny strumień binarny `/ws/pty/<taskId>`: ramki wejścia, wyjścia i zmiany rozmiaru.
- **Uwierzytelnianie**: token z `daemon.json` w nagłówku `Authorization: Bearer`, porównanie w stałym czasie. Odrzucane są żądania, których `Host` lub `Origin` nie jest loopbackiem (DNS rebinding, CSRF ze strony w przeglądarce). Tauri podaje token do WebView przez komendę Tauri, nie przez query string.

### 5.3 Daemon ↔ agent: MCP

Daemon wystawia serwer MCP w transporcie **Streamable HTTP** pod `/mcp` z tym samym tokenem. Dla CLI, które obsługują tylko stdio, jest cienki klient `pitwall-daemon mcp-stdio`, który przekazuje ramki do `/mcp`. Funkcja „podłącz agenta” w UI dopisuje wpis do konfiguracji MCP danego CLI, nie ruszając reszty pliku.

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

Tauri uruchamia daemon jako sidecar z argumentem `--parent <pid>`, czeka na `/api/health`, pokazuje ekran powitalny, a po niepowodzeniu dialog z logiem startu. Zamknięcie okna chowa je do traya. „Wyjdź” z traya wysyła `POST /api/daemon/shutdown`, daemon zatrzymuje serwisy i sesje tym samym łagodnym stopem co Ctrl-C, a Tauri czeka na zakończenie. Daemon sam nie kończy się po śmierci rodzica (tryb „działa przy zamkniętym oknie”), ale sprawdza `--parent` tylko po to, żeby odróżnić start z Tauri od ręcznego.

### 5.5 Daemon ↔ scena 3D

`@pitwall/scene` nie ma własnego transportu: dostaje strumień zdarzeń z tego samego WebSocketu co reszta UI i mapuje go na encje koota (`Kind`, `Status`, `Port`, `Lease`, `Layer`). Układ warstw (FE → BFF → serwisy → bazy) wynika z grafu: warstwa = najdłuższa ścieżka od węzłów bez wejść. Render na żądanie po każdej paczce zdarzeń.

## 6. Model danych

Typy żyją w `packages/protocol`. Poniżej rdzeń; pola pomocnicze pominięte.

```ts
type RepoId = string;      // slug z workspace.yaml, np. "orders-bff"
type ServiceId = string;   // zwykle = RepoId; repo może mieć kilka serwisów
type TaskId = string;      // ulid

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

interface ProcessGroup { id: string; leaderPid: number; command: string[]; cwd: string;
                         startedAt: string; owner: { kind: 'service'|'task'|'run'; id: string } }

interface LogRecord { seq: number; ts: string; source: LogSource; stream: 'stdout'|'stderr'|'pty';
                      level: 'trace'|'debug'|'info'|'warn'|'error'; msg: string;
                      traceId?: string; spanId?: string; fields?: Record<string, unknown>; raw: string }

interface Task {
  id: TaskId; title: string; repo: RepoId; branch: string; worktree: string;
  adapter: 'copilot' | 'claude' | 'codex'; prompt: string;
  state: 'Working'|'Input'|'Approval'|'Plan'|'Done'|'Error'|'Stale';
  stateSource: 'hook'|'osc'|'screen'|'timeout'; stateSince: string;
  budget: { maxMinutes?: number; maxCommits?: number };
  leases: ServiceId[]; changedPaths: string[]; recording: string;
  summary?: string;   // blok podsumowania z protokołu zakończenia
}

interface AuditEntry { id: number; at: string; client: string; tool: string;
                       args: unknown; durationMs: number; ok: boolean; resultDigest: string }
```

Trwałość: SQLite (`~/.pitwall/pitwall.db`) dla repos, cards, edges (cache), services, leases, tasks, audit; JSONL dla logów; nagrania sesji jako pliki; `runtime.json` tylko dla żywych grup procesów. Konfiguracja workspace to `workspace.yaml` w katalogu workspace (lista repo, nadpisania portów, wskazanie repo sekretów), który użytkownik może trzymać w prywatnym repo. Stan nigdy nie miesza się z konfiguracją.

## 7. Przepływy

**Start aplikacji.** Tauri → sidecar → `daemon.json` → `/api/health` → UI ładuje snapshot (`GET /api/snapshot`) i otwiera `/ws` z `seq` ze snapshotu. Daemon przy starcie: sprząta sieroty wg `runtime.json`, odtwarza listę zadań i proponuje wznowienie sesji agentów (komenda wznowienia z adaptera).

**`ws sync`.** Dla każdego repo równolegle (limit współbieżności): fetch, fast-forward gałęzi domyślnej, jeśli `head` ≠ `analysis.commit` to zależności (`mise run setup`) i ekstraktory kart; po wszystkim przeliczenie grafu i zdarzenie `graph.updated`. Repo zmienione lokalnie (brudny worktree) jest pomijane z ostrzeżeniem.

**Uruchomienie serwisu.** UI → `services.start(id)` → `leases.check` → `secrets.resolve(repo)` (git show manifestu `Secret` z gałęzi `origin/<repo>`, klucze z `data` dekodowane z base64, z `stringData` brane wprost, do env) → `mise.run('dev')` przez `procs.spawn` w grupie → `logs` rejestruje źródło i maski → sonda `mise run health` cyklicznie → `service.state`. Awaria: `crashed` z kodem i ostatnią linią stderr na wierszu serwisu, bez restartu w pętli (co najwyżej trzy próby, potem rezygnacja).

**Zadanie agenta.** UI tworzy zadanie (repo, prompt, adapter, budżet) → `vcs.worktree.add` → zapis promptu do pliku → adapter buduje komendę i konfigurację MCP (adres `/mcp`, token zadania) → `procs.spawnPty` → detektory stanu → zdarzenia `task.state` → tray i „skok do czekającego”. Gdy agent zmienia serwis, prosi o dzierżawę (`Approval` w UI lub automatycznie wg ustawienia). Zakończenie: blok podsumowania → `summary`, propozycja PR, oddanie dzierżaw, nagranie zamknięte.

**Błąd cross-repo.** Użytkownik widzi błąd w FE → klika rekord z `trace_id` → `trace(trace_id)` zwraca rekordy z BFF i serwisów w kolejności `seq` → widok osi czasu po serwisach → „utwórz zadanie z tym kontekstem” wkleja do promptu identyfikatory serwisów i zakres `seq`, a agent sam dociąga szczegóły przez MCP.

## 8. Bezpieczeństwo

- Loopback only, token, sprawdzenie `Host`/`Origin`, porównanie w stałym czasie.
- Token zadania (per sesja agenta) zamiast tokenu globalnego: daemon wie, które zadanie woła MCP, może ograniczyć `run_task` do repo zadania i wpisać zadanie do audytu.
- Katalog roboczy procesu zawsze wewnątrz repo lub worktree; ścieżki z wejścia są normalizowane i sprawdzane na wyjście poza korzeń.
- Klon repo sekretów poza workspace, w katalogu niewidocznym dla worktree; w profilu zadania repo sekretów jest wykluczone z narzędzi plikowych agenta (konfiguracja adaptera).
- Zmienne środowiskowe nigdy nie trafiają do logów ani do audytu; maskowanie wartości przed buforem.
- Autostart i „podłącz agenta” tylko z UI; agent nie ma narzędzia do zmiany konfiguracji daemona.
- Jeśli kiedyś pojawią się narzędzia bazodanowe, rola bez superużytkownika i transakcja tylko do odczytu.

## 9. Windows: ryzyka i jak je sprawdzamy wcześnie

| Ryzyko | Co może pójść źle | Jak sprawdzamy |
|---|---|---|
| Job Objects z Bun/Node | brak natywnego API; trzeba N-API lub `koffi`; proces potomny już w innym jobie (np. uruchomiony z terminala VS Code) nie da się dodać bez `JOB_OBJECT_LIMIT_BREAKAWAY_OK` | spike w etapie 1: moduł `procs` z testem „zabij drzewo mise→mvn→java” |
| ConPTY + `node-pty` w Bun | natywny addon może nie działać pod Bun; `bun build --compile` nie osadza `.node` | spike w etapie 1; plan B: Node 22 + SEA, plan C: PTY po stronie Rust w Tauri (`portable-pty`) z mostem do daemona |
| Łagodny stop na Windowsie | brak SIGTERM; `GenerateConsoleCtrlEvent` wymaga wspólnej konsoli; `taskkill` zgłasza sukces przy żywym procesie | stop zawsze potwierdzany obserwacją; dla Spring Boot dodatkowo `POST /actuator/shutdown`, jeśli włączone |
| Wykrywanie stanu Copilot CLI | brak hooków lub inne sekwencje na Windowsie; ekran ConPTY różni się od Unixa | etap 2, prototyp na firmowym komputerze; wzorce ekranu zbierane z nagrań sesji |
| Portable exe | WebView2 może nie być zainstalowany; SmartScreen i AppLocker blokują niepodpisany plik; autoaktualizacja musi podmienić działający plik | etap 1: build z `tauri.conf` → bundle `none` + sprawdzenie WebView2 przy starcie; test na firmowym komputerze; podpis Azure Trusted Signing przed publikacją |
| Długie ścieżki i blokady plików | worktree pod `.worktrees` przekracza 260 znaków; `git worktree remove` nie usuwa plików trzymanych przez proces | `\\?\` i `core.longpaths`; usuwanie worktree dopiero po potwierdzonym stopie grupy |
| Port → właściciel | `netstat`/`Get-NetTCPConnection` wolne; PID bez drzewa | `GetExtendedTcpTable` przez N-API, drzewo z `runtime.json` i Job Object |
| Antywirus / EDR firmowy | losowe spowolnienia, kwarantanna daemona | portable bez pakowania UPX, wczesny test na firmowym komputerze |

## 10. Testy i CI

- `procs` i `logs`: testy integracyjne uruchamiające prawdziwe procesy potomne (skrypt, który odpala wnuka i ignoruje łagodny stop), na obu systemach w macierzy CI.
- `cards`: testy na fixture'ach repo (małe pom.xml, application.yml, package.json) bez sieci.
- `agents`: detektory stanu testowane na nagraniach `.cast` z prawdziwych sesji Copilot CLI; nagrania zanonimizowane trafiają do repo jako fixture'y.
- `api`/`mcp`: kontrakt z `packages/protocol`, testy przez prawdziwy klient MCP SDK.
- CI: `windows-latest` i `macos-latest`, kroki lint → test → build daemona (binarka) → build Tauri portable → artefakty. Wydanie z tagu (`release.yml`): GitHub Release powstaje dopiero po przejściu obu buildów, opis w `docs/release.md`.

## 11. Kamienie milowe (mapowanie na kolejność prac)

1. **Szkielet**: monorepo, `protocol`, daemon z `/api/health`, UI z jednym panelem, Tauri portable na Win i mac, CI. Spike'i: Job Objects, ConPTY/node-pty pod Bun. Wynik: decyzja Bun vs Node (ADR-1 potwierdzony lub odwrócony).
2. **Prototyp Copilot CLI**: PTY w daemonie, xterm w UI, detektory stanu, test na firmowym komputerze. Wynik: które źródła stanu działają i z jaką pewnością.
3. **Workspace**: `workspace.yaml`, sync, generator mise, `procs` + `logs` w pełni, zakładka Serwisy i Zadania, `ws` CLI.
4. **Wiedza**: ekstraktory kart, graf, serwer MCP z narzędziami z §5.3, audyt.
5. **Dopełnienie**: scena 3D, dzierżawy, `trace`, sekrety w wersji docelowej (sops + age).

## 12. Decyzje (ADR w skrócie)

**ADR-1 Runtime daemona: Bun, z zachowaniem zgodności z Node.** Bun daje `bun build --compile` do jednej binarki i wbudowane SQLite. Kod pisany tak, by działał też pod Node 22 (`node:` API, bez API specyficznych dla Bun poza warstwą `platform/`). Jeśli spike z etapu 1 pokaże, że ConPTY lub Job Objects nie działają pod Bun, przechodzimy na Node 22 + SEA bez zmian w modułach.

**ADR-2 Transport UI: HTTP + WebSocket, nie tylko IPC Tauri.** Dzięki temu ten sam UI działa w przeglądarce (etap 1) i w Tauri, a `ws` CLI i testy używają tego samego API. Tauri IPC zostaje dla spraw natywnych: tray, autostart, token.

**ADR-3 MCP w daemonie, transport Streamable HTTP, stdio jako most.** Jeden proces trzyma stan, więc narzędzia MCP nie potrzebują osobnego kanału. Most stdio dla CLI, które HTTP nie obsługują.

**ADR-4 Trwałość: SQLite + JSONL, bez zewnętrznej bazy.** Jedna osoba, jedna maszyna; SQLite wystarcza, a JSONL jest czytelny ręcznie i tani w zapisie.

**ADR-5 Dzierżawy zamiast proxy.** Jedna instancja serwisu na porcie i przejęcie przez zadanie rozwiązuje 90% przypadków bez proxy; interfejs `leases` zostawia miejsce na routing po nagłówku.

**ADR-6 Fakty z ekstraktorów, LLM tylko w polu `description` i w propozycjach z `origin: 'llm'`.** Powtarzalność analizy i możliwość testów bez modelu.

**ADR-7 Nic firmowego w repo.** Wszystkie reguły specyficzne dla firmy (wzorce URL, nazwy topików, adapter GitLab z adresem instancji) są konfiguracją workspace, a ekstraktory przyjmują je jako parametry.

**ADR-8 Tylko Copilot CLI.** (2026-10-23) Jeden adapter agenta. Abstrakcja adaptera zostaje jako granica w kodzie, ale nie jest rozwijana pod inne CLI.

**ADR-9 Bez auto-merge i plannera, na stałe.** (2026-10-23) Zadanie kończy się podsumowaniem i propozycją PR; łączenie i rozbijanie celów robi człowiek. W modelu danych nie ma miejsca na zależności między zadaniami ani kolejkę.

**ADR-10 Repo sekretów trzyma manifesty k8s `Secret`.** (2026-10-23) Gałąź `origin/<repo>` zawiera pliki YAML `kind: Secret`; `secrets.resolve` czyta `data` (base64) i `stringData` (jawny tekst) i mapuje klucze na zmienne środowiskowe 1:1. Nazwy kluczy są porównywane z `runtime.secretNames` z karty repo, stąd `check_secrets`. Docelowe szyfrowanie sops + age nie zmienia formatu, tylko dodaje krok odszyfrowania przed parsowaniem.

## 13. Pytania otwarte

Wszystkie pytania z wizji zostały rozstrzygnięte 2026-10-23 (ADR-8, ADR-9, ADR-10). Prototyp z etapu 2 może być uruchamiany na firmowym komputerze, gdzie Copilot CLI jest dostępny.
