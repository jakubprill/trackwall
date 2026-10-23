# Spike'i etapu 1

Dwa pytania z §9 i ADR-1 dokumentu architektury, na które odpowiedź daje dopiero uruchomienie na prawdziwym Windowsie i macOS:

| Spike                         | Pytanie                                                                                                                                                                                       | Uruchomienie                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| [`job-objects`](job-objects/) | Czy daemon pod Bun (także jako skompilowana binarka) potrafi trzymać drzewo procesów w Job Object i zabić je w całości? Na macOS: czy grupa procesów (`setsid` + `kill(-pgid)`) daje to samo? | `pnpm --filter @trackwall/spike-job-objects spike` |
| [`conpty`](conpty/)           | Która implementacja PTY działa pod Bun na Windowsie (ConPTY) i macOS: `node-pty`, `bun-pty`, wbudowany `Bun.spawn({ terminal })`? Czy przeżywa `bun build --compile`?                         | `pnpm --filter @trackwall/spike-conpty spike`      |

Oba spike'i drukują tabelę wyników, zapisują JSON w `results/` i, w GitHub Actions, dopisują tabelę do podsumowania joba. Workflow CI uruchamia je na `windows-latest` i `macos-latest` (push na `main` albo ręcznie) jako ostatnie kroki joba `desktop`; ich porażka nie czerwieni joba, bo wynikiem spike'a jest wiedza, a nie zielony znaczek.

Wnioski trafiają do ADR-1 w `docs/architecture.md`.
