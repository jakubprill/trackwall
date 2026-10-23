# Zgłaszanie podatności

Podatności zgłaszaj prywatnie przez [GitHub Security Advisories](https://github.com/jakubprill/trackwall/security/advisories/new) („Report a vulnerability” w zakładce Security), nie w publicznym issue ani PR.

W zgłoszeniu opisz wersję Trackwall, system (Windows albo macOS), kroki do odtworzenia i to, co atakujący może dzięki temu zrobić. Nie wklejaj prawdziwych sekretów, tokenów ani nazw firmowych repo; zanonimizuj logi.

## Zakres

Poprawki dostaje tylko najnowsze wydanie z [GitHub Releases](https://github.com/jakubprill/trackwall/releases).

Szczególnie interesują nas:

- dostęp do API, WebSocketu albo MCP daemona bez tokenu lub spoza `127.0.0.1` (sprawdzenie `Host`/`Origin`, DNS rebinding, CSRF);
- uruchomienie komendy, której nie ma w konfiguracji, albo procesu poza repo lub worktree (poza terminalem interaktywnym w UI, który z założenia uruchamia to, co wpisze użytkownik);
- wyciek sekretów do sesji zadania, logów, audytu albo komunikatów błędów;
- zmiana konfiguracji daemona przez narzędzie MCP.

Dziś daemon wystawia tylko HTTP; WebSocket, MCP i sesje zadań są dopiero planowane. Model docelowy opisuje `docs/architecture.md` §8.

Trackwall to projekt jednej osoby, więc odpowiedź może potrwać kilka dni.
