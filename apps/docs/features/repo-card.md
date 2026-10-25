# Repo card and tags

Facts about a repo read from its build and configuration files, without building it.

The "Card" tab in the repo details shows the facts read from the build and configuration files in the latest commit (ADR-25): the Maven, Gradle and npm packages the repo provides and uses, required tools (mise, `.tool-versions`, `.nvmrc`, wrappers), mechanisms (Spring Boot, Feign, Kafka, Helm, React…), Spring Boot apps with their port, HTTP endpoints from controllers with request and response types, the DTOs these endpoints take and return (records, `data class`, classes with fields and enums from Java and Kotlin, with fields and their types; ADR-38), HTTP clients (Feign, `@HttpExchange`, WebClient, RestClient, RestTemplate, addresses from `application*.yml` in every profile, `.env` and the frontend proxy; ADR-30) and build files, every fact with a file and line.

It builds and runs nothing; a card is computed once per commit and lies in `~/.trackwall/cards`. The card gives repo tags (`java`, `typescript`, `frontend`, `backend`, `bff`, `library`, `monorepo` and `no-mise` for a repo without mise tasks in `mise.toml` or in `mise-tasks/`), shown on the repo list with the reason in a tooltip (`no-mise` as the warning "no mise tasks": in such a repo the `setup` and `build` steps of the Batch command and the "mise tasks" tab have nothing to run); the filter above the list narrows it to repos with every selected tag.

Your own tags are given by the `repoTags` key in `~/.trackwall/workspace.yaml` (only by hand for now): a tag and identifier or remote address patterns, for example `repoTags: { core-api: ["*-core"] }`.

## Decisions

Why it works this way: [ADR-25](https://github.com/jakubprill/trackwall/blob/main/docs/architecture.md#12-decisions-adrs-in-brief), [ADR-30](https://github.com/jakubprill/trackwall/blob/main/docs/architecture.md#12-decisions-adrs-in-brief), [ADR-38](https://github.com/jakubprill/trackwall/blob/main/docs/architecture.md#12-decisions-adrs-in-brief) in the architecture document.
