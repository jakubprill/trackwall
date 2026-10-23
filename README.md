# Pitwall (nazwa robocza)

Desktopowa aplikacja open source dla jednej osoby pracującej z wieloma repozytoriami (Java BFF, mikroserwisy, frontendy TS) i wieloma agentami CLI naraz: połączenia między repo, lokalne stawianie serwisów, analiza błędów cross-repo.

Dokumentacja:

- [Architektura](docs/architecture.md)
- [Zasady dla agentów i Definition of done](AGENTS.md)
- [Słownik pojęć](CONTEXT.md)
- [Spike'i etapu 1](spikes/README.md)
- [Wydania i instalacja](docs/release.md)

## Stan

Etap 1 (szkielet): daemon z `/api/health`, UI z panelem daemona, powłoka Tauri z trayem, portable build na Windows i macOS, CI z macierzą Windows + macOS, spike'i Job Objects i PTY.

Przeglądanie repo: w zakładce „Repo” dodajesz lokalny katalog z gitem (pełną ścieżką), a Pitwall pokazuje gałąź, liczbę zmian i ahead/behind, README, pliki i commity z ostatniego commita oraz otwiera repo w VS Code. Lista repo jest w `~/.pitwall/workspace.yaml` i można ją edytować ręcznie. Wymaga `git` w `PATH`.

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
pnpm dev                       # daemon (bun --watch, stan w .pitwall-dev/) + Vite na http://127.0.0.1:5173
pnpm --filter @pitwall/desktop dev   # to samo w oknie Tauri (stan w ~/.pitwall-dev, osobno od wydania)
pnpm lint                      # Biome i knip (pnpm format poprawia formatowanie)
pnpm test                      # testy wszystkich paczek
```

Sam daemon z UI w przeglądarce, bez Tauri:

```sh
pnpm build
bun packages/daemon/src/main.ts --ui
```

Ten sam daemon działa też pod samym Node, bez Bun (ADR-1): `pnpm --filter @pitwall/ui build`, potem `pnpm --filter @pitwall/daemon start:node`.

## Portable build

```sh
pnpm build:desktop   # UI, daemon jako binarka, Tauri bez instalatora
pnpm portable        # out/pitwall-<wersja>-windows-x64.zip albo out/pitwall-<wersja>-macos-<arch>.zip
```

Windows: zip zawiera `pitwall.exe`, `pitwall-daemon.exe` i `ui/`. Rozpakowanie i uruchomienie `pitwall.exe` wystarcza; stan trafia do `%USERPROFILE%\.pitwall`. Bez WebView2 `pitwall.exe` pokazuje komunikat, a `pitwall-daemon.exe --ui` otwiera Pitwall w przeglądarce. Pliki nie są podpisane, więc SmartScreen pokaże ostrzeżenie (podpis jest zaplanowany przed publikacją, §9).

macOS: zip zawiera niepodpisany `Pitwall.app`; pierwsze uruchomienie przez prawy klik > Otwórz albo `xattr -dr com.apple.quarantine Pitwall.app`.

Każdy przebieg CI publikuje oba archiwa jako artefakty.

## Licencja i bezpieczeństwo

Kod jest na licencji MIT (`LICENSE`). Podatności zgłaszaj prywatnie według `SECURITY.md`.
