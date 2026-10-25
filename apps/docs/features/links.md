# trackwall:// links

Links that open a repo, session or task in Trackwall.

`trackwall://repo/<repo id>`, `trackwall://session/<session id>` and `trackwall://task/<task id>` open the Trackwall window at that repo (in "Repos"), session or task (in "Sessions"; a task link also opens a task proposal), and start Trackwall if it is not running (ADR-52). Agents with the Trackwall MCP server know the format, so a session can point you at a repo or a task in its answer; in a session terminal in Trackwall, Ctrl+click (Cmd+click on macOS) opens such a link. A link only shows something: it never starts, stops or approves anything, and a link Trackwall does not recognise just shows the window.

On macOS the system registers the scheme once you have started the app; on Windows the portable `trackwall.exe` registers it for your user at every start, so after moving the folder links work again once you have started Trackwall from the new place, and with two copies the one started last gets the links. `pnpm dev` does not register links.

## Decisions

Why it works this way: [ADR-52](https://github.com/jakubprill/trackwall/blob/main/docs/architecture.md#12-decisions-adrs-in-brief) in the architecture document.
