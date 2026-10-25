# mise tasks

Run, stop and follow the mise tasks of a repo, with their logs.

The "mise tasks" tab in the repo details shows the tasks from `mise tasks ls`, runs them (`mise run <task>` in the repo root) and stops them as a whole process group, together with their descendants (a Job Object on Windows, a POSIX session on macOS, ADR-20); after an error it shows the exit code and the last output lines. The "Log" button next to a task shows its output live (stdout and stderr, without ANSI colours, errors and warnings highlighted), and a run opens the log by itself; the values of environment variables with secret names (`*_TOKEN`, `*_PASSWORD`, `*_SECRET`…) are replaced with `***` in the log.

The full log of every task lies in `~/.trackwall/logs/mise-task/<repo>/<task>.jsonl` (at most 10 MB plus one previous file `.1.jsonl`); in the file name characters other than lowercase letters, digits, `_` and `-` are encoded as `%XX`, for example the task `build:ui` is `build%3Aui.jsonl`. A mise configuration that mise does not trust can be trusted with a button (`mise trust`); only then can an agent also run the repo's tasks through the [MCP server](/features/mcp). Tasks run by an agent show in the same tab, with their log, and can be stopped from here. Quitting the daemon stops all tasks, and its next start cleans up the groups after a daemon crash. Needs `mise` in `PATH` (on macOS the `PATH` from the login shell is enough).

## Decisions

Why it works this way: ADR-20 in [§12 of the architecture document](https://github.com/jakubprill/trackwall/blob/main/docs/architecture.md#12-decisions-adrs-in-brief).
