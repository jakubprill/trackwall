---
title: Environment variables
description: Every environment variable Trackwall reads, sets for sessions and mise tasks, or hides from an agent's tools, in one table to look things up.
---

# Environment variables

Every environment variable Trackwall reads, sets for sessions and mise tasks, or hides from an agent's tools, in one table to look things up.

An agent's environment is built in layers: your own, then mise's for the folder it works in, then what Trackwall adds. [Where agents work](/guide/where-agents-work) explains which folder that is for each kind of session.

## Variables you set for Trackwall

| Variable | What it does |
|---|---|
| `TRACKWALL_HOME` | Trackwall's own folder instead of `~/.trackwall` (`%USERPROFILE%\.trackwall` on Windows): `workspace.yaml`, the task list, logs and the files of each session. The app and Trackwall's background service both read it. Set it before Trackwall starts, for example to keep the folder inside your projects folder. |

## Variables sessions get

A session's Copilot CLI starts with your environment, with these on top:

| Variable | Where it comes from | What for |
|---|---|---|
| Your `[env]` from mise | the `mise.toml` and `mise.local.toml` files of the folder the session works in and every folder above it | tokens and settings, as your terminal gets them with mise activated; see [Environment from mise](/features/mise-environment) |
| `NO_PROXY` | Trackwall adds `127.0.0.1` to yours | Copilot CLI reaches Trackwall on your computer directly, past a proxy you use for everything else |
| `COPILOT_HOOK_ALLOW_LOCALHOST` | Trackwall sets it to `1` | Copilot CLI tells Trackwall what the agent is doing, such as that it waits for your approval |
| `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` | Trackwall adds its folder after yours | the [session instructions](/features/session-instructions) |
| `TERM`, `COLORTERM` | Trackwall | colours in the terminal inside Trackwall |

## Variables mise tasks get

A mise task that Trackwall runs, from the "mise tasks" tab, [Services](/features/services), the [Batch command](/features/batch-command) or an agent, gets the environment mise sets for its folder. In an [agent task](/features/tasks)'s worktree it also gets:

| Variable | What for |
|---|---|
| `SERVER_PORT`, `PORT` | the task's own port, shown in the task's header, so a service started from the worktree runs next to yours instead of taking its port |
| `MISE_TRUSTED_CONFIG_PATHS` | the worktree, added for that one run, so mise uses the config you trusted without trusting the folder for good |

## Variables hidden from an agent's tools

Copilot CLI itself has every variable, but the commands the agent runs and the MCP servers Copilot CLI starts do not get these:

| Variable | Why |
|---|---|
| Secrets from mise | values encrypted with `mise set --age-encrypt`, marked `redact = true`, or named like a secret (`GITLAB_TOKEN`, `DB_PASSWORD`); list the ones the tools need in `agentSecrets` in `workspace.yaml` |
| `MISE_AGE_KEY` | it decrypts every secret, so the agent's tools never get it unless you list it in `agentSecrets` |

The session panel shows the names of the variables a session got from mise and which secrets are hidden, never their values. A secret's value is replaced with `***` in mise task logs and in the last lines of an ended session.

## Good to know

- Trackwall reads the environment when a session starts. A change to a `mise.toml` or to your own variables reaches a session after you resume or start it again; a new `TRACKWALL_HOME` needs Trackwall to restart.
- Variable names are matched the way your system matches them: on Windows `Path` and `PATH` are one variable, and Trackwall keeps your spelling.
- Without `mise` on your `PATH`, sessions and tasks get your own environment only, with Trackwall's variables on top.
- Hiding a secret keeps it out of the agent's commands by accident, not from an agent that tries: it can run `mise env` like any program you run.
