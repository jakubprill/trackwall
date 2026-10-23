# Pitwall: zasady dla agentów

Pitwall piszą głównie agenci, a człowiek czyta kod od czasu do czasu. Każda zasada poniżej istnieje po to, żeby następny agent albo osoba zaglądająca z boku mogli zrozumieć zmianę i jej zaufać bez dopytywania. Gdy zasada i intuicja się różnią, wygrywa zasada. Gdy zasada jest zła, zmień ją tutaj w tym samym PR i napisz dlaczego.

Mapa repo i uruchomienie ze źródeł: `README.md`. Architektura i granice modułów: `docs/architecture.md`. Słownik pojęć: `CONTEXT.md`. Wydania: `docs/release.md`.

W tym pliku „agent” to agent piszący kod Pitwall. Agent uruchamiany przez Pitwall w zadaniu nazywa się tu „sesją zadania”.

## Definition of done

Zmiana jest gotowa, gdy spełnia wszystkie punkty, a nie wtedy, gdy się kompiluje:

1. **Działa i ma test** na najtańszym poziomie, który to udowadnia: test w katalogu `test/` paczki (`bun test`), test z prawdziwym procesem potomnym dla `procs` i `logs`, `cargo test` dla powłoki Tauri. Poprawka błędu zaczyna się od testu, który bez niej nie przechodzi.
2. **Działa na Windowsie i macOS.** Kod zależny od systemu ma test, który CI uruchamia w macierzy `windows-latest` + `macos-latest`. Czego nie da się sprawdzić w CI (WebView2, SmartScreen, firmowy komputer), wypisz w PR jako „do sprawdzenia ręcznie”.
3. **Lokalnie przechodzą** `pnpm lint`, `pnpm typecheck` i `pnpm test`, a gdy zmiana dotyka `apps/desktop`, buildu daemona albo pakowania, także kroki joba `desktop` z `.github/workflows/ci.yml` (sekcja „Komendy”). CI potwierdza, a nie szuka błędów.
4. **Dokumentacja opisuje nowe zachowanie w tym samym PR** (sekcja „Dokumentacja”).
5. **Nic firmowego** w kodzie, testach, fixture'ach, dokumentacji i commitach (sekcja „Nic firmowego w repo”).
6. **Przegląd przed PR jest zrobiony** (sekcja „Przegląd przed PR”): uwagi poprawione albo odrzucone z uzasadnieniem.
7. **Opis PR** według `.github/pull_request_template.md`: co się zmieniło dla użytkownika (przed/po), dlaczego, jak to sprawdzono i co zostało do sprawdzenia ręcznie.

Nie osłabiaj sprawdzeń, żeby było zielono: żadnych pominiętych ani usuniętych testów, `biome-ignore` bez powodu w tym samym komentarzu, wyłączonej reguły w `biome.json`, `--no-verify`, `continue-on-error` na jobie, który ma blokować. Jeśli reguła przeszkadza słusznie, zmień ją w tym samym PR i napisz dlaczego.

## Przegląd przed PR

Przed otwarciem PR i przed każdym kolejnym pushem z nowym kodem zmiana przechodzi bezlitosny przegląd kodu. Trzy niezależne przeglądy, każdy uruchomiony osobno, a ich uwagi złączone w jedną listę:

- `/thermo-nuclear-code-quality-review` (skill w `.claude/skills/`, kopia z wtyczki Thermos w `cursor/plugins`, licencja MIT obok): struktura, abstrakcje, rozrost plików, „code judo”. Oryginał ma `disable-model-invocation: true`; kopia nie ma tej linii, żeby agent mógł go uruchomić sam. Przy aktualizacji z oryginału usuń ją ponownie.
- `/code-review`: błędy poprawności, każda uwaga zweryfikowana.
- `mattpocock-skills:code-review`: zgodność z udokumentowanymi zasadami (ten plik, `CONTEXT.md`, `docs/architecture.md`) i z tym, o co prosiło zadanie.

Pierwsza runda idzie na najwyższym poziomie (`/code-review max`), kolejne na diffie poprawek (`high`). Kończysz, gdy runda nie przynosi potwierdzonej uwagi do poprawienia; po trzech rundach to, co zostało, trafia do opisu PR jako świadomie zostawione. Jeśli któregoś skilla nie ma w środowisku, zrób ten przegląd przez osobnego subagenta z tym samym zakresem i napisz to w PR. W opisie PR: ile było rund, co poprawiono, co odrzucono i dlaczego.

## Dokumentacja

- **`docs/architecture.md` jest jedynym dokumentem architektury.** Zmiana granicy modułu, protokołu, modelu danych albo przepływu aktualizuje odpowiednią sekcję w tym samym PR. Przeszukaj cały dokument pod kątem starego zachowania, nie tylko oczywistą sekcję.
- **Decyzje trafiają do §12 jako ADR.** Nowy ADR ma numer, datę, jedno zdanie decyzji, uzasadnienie i to, co by ją odwróciło. Wynik spike'a albo doprecyzowanie dopisuje się do istniejącego ADR (tak jak wnioski ze spike'ów do ADR-1). Decyzji odwróconej się nie kasuje: nowy ADR, a stary dostaje dopisek „zastąpiona przez ADR-N”.
- **Nowe pojęcie domenowe trafia do `CONTEXT.md`** razem z identyfikatorem w kodzie. Od tej chwili to jedno słowo obowiązuje w kodzie, UI, narzędziach MCP i dokumentacji.
- Zmiana komend, wymaganych narzędzi albo układu repo aktualizuje `README.md` (i sekcję „Komendy” poniżej, jeśli dotyczy Definition of done). Zmiana procesu wydania aktualizuje `docs/release.md`.

## Język

- Dokumentacja, komentarze, komunikaty commitów, tytuły i opisy PR, nazwy testów oraz teksty dla użytkownika (UI, komunikaty CLI) po polsku.
- Identyfikatory, kody błędów API (`error.code`), nazwy zdarzeń i narzędzi MCP po angielsku.

## Nic firmowego w repo

Repo ma zostać opublikowane jako open source (nagłówek `docs/architecture.md`), a wszystko, co firmowe, żyje w konfiguracji workspace (ADR-7). Nigdy nie wpisuj w kod, testy, fixture'y, dokumentację ani commity nazwy firmy, klienta, wewnętrznych hostów, adresów GitLaba, nazw repo czy topików z pracy. Reguły specyficzne dla firmy przychodzą jako parametry z workspace. Nagrania sesji i logi użyte jako fixture'y są zanonimizowane przed commitem.

## Bezpieczeństwo

- **Daemon słucha tylko na `127.0.0.1`.** Każde żądanie HTTP, WebSocket i MCP przechodzi sprawdzenie `Host`/`Origin`, a poza `GET /api/health` i statycznymi plikami UI wymaga też tokenu, porównywanego w stałym czasie. Robi to `handle()` w `packages/daemon/src/api/server.ts` z pomocą `api/guard.ts`; nowy transport używa tych samych funkcji, nie własnych.
- **Wszystko z zewnątrz jest niezaufane**: ciała żądań, argumenty narzędzi MCP, pliki konfiguracji, wyjście procesów, pliki z repo użytkownika. Wchodzi przez schemat zod (`safeParse` w miejscu wejścia; schematy kontraktu API w `packages/protocol`).
- **Daemon składa komendy z konfiguracji, nigdy z tekstu od sesji zadania** (§1.2). Procesy serwisów, tasków mise i sesji zadań startują tylko przez moduł `procs`, w grupie, z katalogiem roboczym sprawdzonym względem korzenia repo lub worktree.
- **Sekrety nie trafiają do sesji zadania ani do logów**: wartości są maskowane przed zapisem do bufora, narzędzia MCP odpowiadają „ustawiony / brak”, zmienne środowiskowe nie trafiają do audytu, komunikatów błędów ani fixture'ów.
- Żadne narzędzie MCP nie zmienia konfiguracji daemona, autostartu ani listy podłączonych agentów; to robi tylko UI.
- Agent nie wypycha tagów, nie tworzy wydań i nie zmienia ustawień repo. Wydanie robi człowiek według `docs/release.md`.
- Lukę, której nie zamykasz w PR, dopisz do §8 architektury i wymień w opisie PR.

## Windows pierwszy

- Ścieżki tylko przez `node:path` i `node:os`; żadnego sklejania z `/` ani zakładania, że katalog domowy to `~`. Pamiętaj o limicie 260 znaków i plikach blokowanych przez działające procesy.
- Skrypty w repo są w TypeScript (`bun scripts/...`), nie w bash ani PowerShell, żeby działały tak samo na obu systemach. Wyjątek: kroki `run:` w workflow GitHub Actions.
- Stan procesu się obserwuje, nie zakłada (§1.3): „zatrzymany” dopiero po sprawdzeniu, że cała grupa nie żyje i port jest wolny. `taskkill` i kod wyjścia to za mało.
- Bez dowiązań symbolicznych w repo: na Windowsie git domyślnie zamienia je w pliki tekstowe.
- `fetch` w Bun kieruje `127.0.0.1` przez `HTTP_PROXY`. W daemonie i jego skryptach do loopbacku służy `loopbackRequest` z `packages/daemon/src/loopback.ts`; gdy będzie potrzebny poza daemonem (CLI `ws`), trafia do osobnej paczki tylko dla Node/Bun, nie do `protocol`, który musi działać w przeglądarce.

## Kod czytelny dla agentów i ludzi

- **Nazwy mówią, czym rzecz jest w domenie**, tym samym słowem co `CONTEXT.md`, UI i narzędzia MCP. Jedno pojęcie, jedna nazwa.
- **Granice modułów z §4 są twarde.** Moduł daemona nie importuje innego modułu bezpośrednio, tylko przez fasadę; nowa zależność między modułami wymaga zmiany tabeli w §4. UI, scena i CLI nie importują `@pitwall/daemon`; wspólny kod biorą tylko z `@pitwall/protocol`. Pliki infrastruktury daemona (start, odkrywanie, `platform/`) nie są modułami i nie trzymają stanu domenowego.
- **Typy są kontraktem i pochodzą z kodu**: z wartości, ze schematów zod (`z.infer`). Bez `any`. Zamiast `!` jawne sprawdzenie i wyjątek z opisem. Asercja `as` to twierdzenie, którego kompilator nie sprawdzi: dane z zewnątrz (`JSON.parse`, odpowiedzi HTTP, pliki, argumenty CLI) nigdy nie są rzutowane, tylko parsowane schematem. Poza tym `as` tylko tam, gdzie typ z biblioteki jest szerszy niż to, co wiadomo w danym miejscu (`server.address() as AddressInfo`, błąd w `catch` jako `NodeJS.ErrnoException`), oraz w testach do budowania atrap. Kod w `spikes/` jest wyłączony z tej zasady, bo nie trafia do aplikacji.
- **Małe funkcje i pliki o jednym celu.** Plik, który robi dwie rzeczy, staje się dwoma plikami.
- **Jedno miejsce dla każdej reguły.** Zanim napiszesz helper, poszukaj istniejącego. Zduplikowana logika to błąd, który czeka, aż kopie się rozjadą.
- **Komentarze tłumaczą dlaczego, nie co.** Nieoczywisty moduł zaczyna się od krótkiego komentarza: do czego służy, co gwarantuje, gdzie jest opisany (sekcja architektury).
- **Jawnie zamiast sprytnie**: bez magicznych napisów współdzielonych między plikami (eksportuj stałą), bez ukrytego stanu globalnego, bez cichych wartości domyślnych dla czegoś, co musi być ustawione.
- **Usuwaj martwy kod** zamiast go komentować.
- **Nazwy plików**: kebab-case (`open-browser.ts`), komponenty React w PascalCase (`DaemonPanel.tsx`). Wyjątek: komponenty shadcn/ui w `components/ui/` zostają pod nazwami, które nadaje generator (`button.tsx`).
- **Zależności npm w dokładnych wersjach** (bez `^` i `~`). Nie dodawaj zależności do czegoś, co załatwia kilka linii kodu. Natywny addon wymaga sprawdzenia, że działa w `bun build --compile` na obu systemach (patrz `spikes/`).
- **Testy czytają się jak dokumentacja**: nazwa testu to zdanie opisujące zachowanie, a test pokazuje wejście i oczekiwany wynik bez helperów, które je ukrywają.
- **Reguły egzekwuje narzędzie wszędzie, gdzie się da**: reguła w linterze trzyma lepiej niż zdanie w tym pliku. Dziś Biome ma tylko zestaw `recommended`, więc większości zasad z tej sekcji pilnuje przegląd. Gdy powtarzasz tę samą uwagę w przeglądzie, zamień ją w regułę.

## Komendy

Pełny opis uruchamiania jest w `README.md`. Do Definition of done:

```sh
pnpm lint              # Biome: format, lint, kolejność importów (pnpm format poprawia)
pnpm typecheck
pnpm test              # bun test we wszystkich paczkach

# gdy zmiana dotyka apps/desktop, buildu daemona albo pakowania (job `desktop` w CI):
pnpm build:desktop
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
bun packages/daemon/scripts/smoke.ts apps/desktop/src-tauri/target/release/pitwall-daemon   # z .exe na Windowsie
pnpm portable
```

Wersje narzędzi są w `mise.toml` (`mise install`).

## Commity i PR

- Praca idzie przez PR do `main`, nigdy push prosto na `main`.
- Jeden temat na PR. Nie mieszaj refaktoryzacji ze zmianą zachowania, chyba że refaktoryzacja jest do niej potrzebna.
- Komunikaty commitów i tytuły PR w trybie rozkazującym, jak w historii („Dodaj…”, „Rozstrzygnij…”).
- Wersję podbija się tylko przy wydaniu, w trzech miejscach naraz (`docs/release.md`).
