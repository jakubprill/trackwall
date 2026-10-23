# Słownik Pitwall

Pojęcia, które łatwo pomylić. Kod, UI, narzędzia MCP i dokumentacja używają tych słów i tylko tych. Szczegóły są w `docs/architecture.md`; tu jest tylko to, co trzeba wiedzieć, żeby nazwać rzecz poprawnie. Nowe pojęcie dopisuje się w tym samym PR, w którym się pojawia.

## Aplikacja

**Daemon**:
Proces `pitwall-daemon`, który trzyma cały stan i całą logikę. Jedyne źródło prawdy; UI, CLI `ws` i serwer MCP są jego klientami.
_Unikaj_: backend, serwer (bez dopowiedzenia)

**Powłoka** (desktop):
Aplikacja Tauri: okno, tray, uruchamianie i zatrzymywanie daemona jako sidecara. Nie zawiera logiki.
_Unikaj_: aplikacja (gdy chodzi tylko o Tauri)

**Fasada**:
Zbiór interfejsów modułów daemona przekazywany do transportów (HTTP, MCP, zdarzenia). Moduły rozmawiają ze sobą tylko przez nią.

**Moduł**:
Wydzielona część daemona z §4 architektury (`procs`, `logs`, `workspace`…), z jawnym interfejsem i listą zależności.
_Unikaj_: serwis (to byt z workspace, patrz niżej), paczka

**Paczka**:
Workspace pnpm w `packages/` lub `apps/` (`@pitwall/daemon`, `@pitwall/protocol`…).

## Workspace i wiedza

**Workspace**:
Zbiór repo użytkownika opisany w `workspace.yaml`, poza repozytorium Pitwall. Tu żyje wszystko, co firmowe.
_Unikaj_: projekt

**Repo**:
Jedno repozytorium z workspace, identyfikowane slugiem (`RepoId`).

**Karta** (karta repo):
Fakty o repo wyciągnięte deterministycznie z plików buildu i konfiguracji: co repo udostępnia (provides), czego używa (consumes) i czego potrzebuje do działania (runtime). LLM dopisuje tylko opis.
_Unikaj_: profil, metadane

**Ekstraktor**:
Wtyczka per stack (`spring`, `node`), która czyta pliki repo i zwraca fakty z pozycją w pliku.

**Graf**:
Złączenie kart: węzły to serwisy, krawędzie łączą consumes jednego z provides drugiego.

**Krawędź**:
Połączenie w grafie z rodzajem (`http`, `topic`, `package`, `env-url`), kluczem, pewnością i dowodami.

**Dowód** (evidence):
Plik i linia, z których wynika fakt na karcie lub krawędź w grafie.

**Pewność** (confidence):
`exact`, `high`, `medium` albo `low`. Przy `low` daemon niczego nie robi automatycznie.

## Procesy i serwisy

**Serwis**:
Repo plus jego task mise `dev`, port i sonda zdrowia. Jedno repo może mieć kilka serwisów.
_Unikaj_: aplikacja, mikroserwis (gdy chodzi o byt w Pitwall)

**Stan serwisu**:
`stopped`, `starting`, `healthy`, `unhealthy`, `stopping` albo `crashed`; zawsze zaobserwowany, nigdy założony.

**Grupa procesów**:
Proces lider i wszyscy jego potomkowie, zatrzymywani razem: Job Object na Windowsie, sesja (`setsid`) na macOS.
_Unikaj_: drzewo procesów (gdy chodzi o jednostkę zarządzaną)

**Sonda** (health):
Task mise `health` uruchamiany cyklicznie; jego wynik decyduje o `healthy` / `unhealthy`.

**Dzierżawa**:
Informacja, która gałąź albo worktree zajmuje serwis na jego porcie. Domyślnie repo główne; zadanie może ją przejąć i oddać.
_Unikaj_: lock, rezerwacja

**Sierota**:
Grupa procesów z `runtime.json`, której daemon już nie nadzoruje (np. po awarii). Sprzątana tylko, gdy komenda i czas startu lidera się zgadzają.

## Agenci

**Zadanie**:
Praca jednego agenta nad jednym repo: prompt, worktree, gałąź, sesja, budżet, dzierżawy i podsumowanie.
_Unikaj_: task (to słowo jest zajęte przez mise), job

**Task** (mise):
Nazwana komenda z `mise.toml` repo: `setup`, `dev`, `test`, `build`, `lint`, `health`.

**Adapter**:
Wszystko, co Pitwall wie o jednym CLI agenta: szablon komendy, konfiguracja MCP, wznowienie, detektory stanu. Jedyny adapter to Copilot CLI (ADR-8).

**Sesja**:
CLI agenta działające w PTY należącym do daemona, nagrywane do `sessions/<zadanie>.cast`.

**Stan zadania**:
`Working`, `Input`, `Approval`, `Plan`, `Done`, `Error` albo `Stale`, zawsze ze źródłem (`hook`, `osc`, `screen`, `timeout`) i pewnością.

**Detektor stanu**:
Reguła, która z hooków, sekwencji terminala albo wyglądu ekranu wnioskuje stan zadania.

**Podsumowanie**:
Blok, którym agent kończy zadanie; trafia do pola `summary` i do propozycji PR.

## Logi i audyt

**Rekord** (logu):
Jedna linia wyjścia procesu po parsowaniu: `seq`, czas, źródło, poziom, treść, opcjonalnie `trace_id`.
_Unikaj_: wpis, event

**`seq`**:
Globalny, rosnący numer rekordu dla wszystkich źródeł. Kursor `since_seq` działa dla jednego serwisu i dla całego workspace.

**Zdarzenie**:
Wiadomość daemona na WebSocket (`service.state`, `task.state`…) z własnym `seq` zdarzeń.
_Unikaj_: rekord (to log)

**Maskowanie**:
Zamiana wartości sekretów na `***` przed zapisem rekordu do bufora.

**Audyt**:
Zapis każdego wywołania narzędzia MCP: klient, narzędzie, argumenty, czas, skrót wyniku. Widoczny tylko w UI.

## Sekrety

**Repo sekretów**:
Repozytorium z manifestami k8s `Secret`, po jednej gałęzi `origin/<repo>` na repo z workspace (ADR-10). Klonowane poza workspace.

**Sekret**:
Klucz z `data` albo `stringData` manifestu, wstrzykiwany jako zmienna środowiskowa o tej samej nazwie. Agent widzi tylko, czy jest ustawiony.
