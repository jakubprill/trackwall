---
title: Environment variables
description: The environment variables you set for Trackwall, and those it gives or hides from sessions and mise tasks, in tables to look things up.
---

# Environment variables

The environment variables you set for Trackwall, and those it gives or hides from sessions and mise tasks, in tables to look things up.

An agent's environment is built in layers: your own, then mise's for the folder it works in, then what Trackwall adds. [Where agents work](/guide/where-agents-work) explains which folder that is for each kind of session.

## Variables you set for Trackwall

| Variable | What it does |
|---|---|
| `TRACKWALL_HOME` | Trackwall's own folder instead of `~/.trackwall` (`%USERPROFILE%\.trackwall` on Windows): `workspace.yaml`, the task list, logs and the files of each session. An empty value counts as not set. |
| `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` | the proxy Trackwall and git use to reach your repo hosts, as in your terminal |
| `GIT_SSH_COMMAND`, `GIT_SSH` | your own ssh program for git; without one, Trackwall makes ssh fail instead of waiting for a password it cannot ask for |

Trackwall reads these when it starts, so set them where the app sees them: on Windows in your account's environment variables, on macOS with `launchctl setenv` (an app opened from the Dock or Finder does not read your shell profile). Then choose "Quit" in Trackwall's tray menu and start it again.

## Variables sessions get

A session's Copilot CLI starts with your environment, with these on top:

| Variable | Where it comes from | What for |
|---|---|---|
| Your `[env]` from mise | the mise config of the folder the session works in and every folder above it | tokens and settings, as your terminal gets them with mise activated; see [Environment from mise](/features/mise-environment) |
| `NO_PROXY` | Trackwall adds `127.0.0.1` to yours | Copilot CLI reaches Trackwall on your computer directly, past a proxy you use for everything else |
| `COPILOT_HOOK_ALLOW_LOCALHOST` | Trackwall sets it to `1` | Copilot CLI tells Trackwall what the agent is doing, such as that it waits for your approval |
| `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` | Trackwall adds its folder after yours | the [session instructions](/features/session-instructions) |
| `TERM`, `COLORTERM` | Trackwall | colours in the terminal inside Trackwall |

## Variables mise tasks get

A mise task that Trackwall runs, from the "mise tasks" tab, [Services](/features/services), the [Batch command](/features/batch-command) or an agent, gets your environment and what mise sets for its folder. In an [agent task](/features/tasks)'s worktree it also gets:

| Variable | What for |
|---|---|
| `SERVER_PORT`, `PORT` | the task's own port, shown in the task's header, so a service started from the worktree runs next to yours instead of taking its port; the agent's own shell does not have them |
| `MISE_TRUSTED_CONFIG_PATHS` | the worktree, added for that one run, so mise uses the config you trusted without trusting the folder for good |

## Variables left out

| Variable | Left out of | Why |
|---|---|---|
| `TRACKWALL_HOME` | sessions and mise tasks | it is Trackwall's setting, not the repo's |
| Secrets from mise | the agent's shell and the MCP servers Copilot CLI starts, unless `agentSecrets` names them | see [Environment from mise](/features/mise-environment) for what counts as a secret |
| `MISE_AGE_KEY` | the agent's shell and MCP servers, unless `agentSecrets` names it | it decrypts every secret |
| A secret whose name Copilot CLI cannot hide | the whole session | it would reach the agent's tools unhidden; the session panel names it |

## Good to know

- With a [session profile](/features/mise-environment#use-another-model-provider), mise reads a session's place with `MISE_ENV` set to it, so the session gets the variables of `mise.<profile>.toml` too. The session does not get `MISE_ENV` itself, and mise tasks and services never use the profile.
- Trackwall reads mise when a session starts: a change to a `mise.toml` reaches a session after you resume or start it again. A change to your own variables reaches sessions only after Trackwall restarts.
- Variable names are matched the way your system matches them: on Windows `Path` and `PATH` are one variable, and Trackwall keeps your spelling.
- Without `mise` on your `PATH`, sessions and mise tasks get your own environment only, with Trackwall's variables on top.
- On macOS Trackwall takes `PATH` from your login shell, so the tools your terminal finds, such as `mise` from Homebrew, are found in sessions and mise tasks too.
