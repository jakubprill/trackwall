# Connection graph

See which repo uses which, through packages and HTTP clients.

The "Overview" view (Ctrl+4) draws the repos from the folder as a graph (ADR-29): a line leads from a repo that uses a package to the repo that builds it (Maven coordinates, also from Gradle, and npm names from the cards), and from a repo whose HTTP client calls another repo's app or endpoints (by app name, host, port on `localhost` or paths; ADR-30), from frontends on the left to libraries on the right. Every connection has a confidence: certain, almost certain, likely or possible. Clicking a repo shows in the panel on the right what it uses and who uses it, with evidence (file and line).

Connections the cards do not see are added by hand under the `graph` key in `~/.trackwall/workspace.yaml`: `packages` assigns a package to a repo (`com.example:orders-client: orders-api`), `apps` an app name or an address host to a repo (`orders.internal.example.com: orders-api`), and `edges` adds a connection with a description (`- { from: shop-web, to: orders-bff, note: HTTP /api/orders }`); a repo is given by its identifier or its `host/path` address.

## Decisions

Why it works this way: [ADR-29](https://github.com/jakubprill/trackwall/blob/main/docs/architecture.md#12-decisions-adrs-in-brief), [ADR-30](https://github.com/jakubprill/trackwall/blob/main/docs/architecture.md#12-decisions-adrs-in-brief) in the architecture document.
