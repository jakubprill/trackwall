# Batch command

Sync, install and build many repos with one command.

The "Batch command" button under the repo list opens a panel in which you choose repos (by default all visible after the tag filter) and steps: sync, tools (`mise install`), dependencies (the mise task `setup`) and build (the mise task `build`). The steps run in a repo in order, and repos three at once; the panel shows the result of every step in every repo, and on an error the exit code and the last lines. A repo without the task has the step skipped, an error ends only that repo, and "Cancel" stops the running tasks (also one started earlier from the repo details, which the command joined) and starts no further ones. A repeat is fast when the tasks have `sources` and `outputs` in `mise.toml` (ADR-27).

## Decisions

Why it works this way: ADR-27 in [§12 of the architecture document](https://github.com/jakubprill/trackwall/blob/main/docs/architecture.md#12-decisions-adrs-in-brief).
