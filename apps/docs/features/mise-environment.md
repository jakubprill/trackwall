---
title: Environment from mise
description: Give every agent session the variables and tokens from your mise config, with secrets encrypted on disk and kept from the agent's tools.
---

# Environment from mise

Give every agent session the variables and tokens from your mise config, with secrets encrypted on disk and kept from the agent's tools.

## What you get

- Every Copilot CLI session gets the `[env]` of your mise config, as your terminal does with mise activated.
- One `mise.toml` in your projects folder sets tokens and settings for every repo, task and the supervisor.
- Secrets stay encrypted in the file and are decrypted only when a session starts.
- The agent's shell and its local MCP servers get only the secrets you name.
- The session panel shows which variables a session got, never their values.

## How it works

mise reads every config from the folder a session works in up to the projects folder, so a `mise.toml` in the projects folder applies to every repo in it, and a repo's own `mise.toml` adds to it or overrides it. When Trackwall starts a session, it asks mise for that environment and gives it to Copilot CLI over your own. A session in a repo gets the repo's environment, an [agent task](/features/tasks) gets its worktree's, and the [supervisor](/features/supervisor) and a free session get the projects folder's.

A value you write with `mise set --age-encrypt` sits in the file encrypted, and mise decrypts it with your age key. mise marks such values, and those you mark with `redact = true`, as secrets; Trackwall also treats a variable whose name looks like a secret (`GITLAB_TOKEN`, `DB_PASSWORD`) as one. Copilot CLI itself has every variable, but the agent's shell and its local MCP servers do not get the secrets unless you list them in `agentSecrets`. A secret never shows in a mise task's log or in the last lines of an ended session: Trackwall replaces it with `***`.

Under the session's header a line says how many variables it got from mise, which secrets are hidden from the agent's tools and which they get. When mise cannot give the environment where the session works, for example because the repo's config is not trusted yet or the age key is missing, the line says why, and the session gets the environment of the folder above it instead. If `MISE_AGE_KEY` is in your own environment, the agent's tools do not get it either.

## Use it

1. Install the age tool with mise (`mise use -g age`), create a key with `age-keygen -o ~/.config/mise/age.txt` and turn on mise's experimental features (`mise settings experimental=true`).
2. In your projects folder, add a secret with `mise set --age-encrypt --stdin GITLAB_TOKEN`: paste the value, then press Enter and Ctrl+D (Ctrl+Z and Enter on Windows).
3. Add plain settings to the same `mise.toml` under `[env]`, such as `MAVEN_OPTS = "-Xmx2g"`.
4. Trust the config once with `mise trust` in the projects folder.
5. If an MCP server or a command of the agent needs a token, add it to `~/.trackwall/workspace.yaml`:

   ```yaml
   agentSecrets:
     - GITLAB_TOKEN
   ```

6. Start a session: the line under its header lists what it got.

## Good to know

- It needs `mise` on your `PATH`. Without it sessions start with your own environment only.
- Trackwall reads the environment when a session starts. A change to `mise.toml` reaches a session after you resume or start it again.
- A config mise does not trust is never trusted for you: trust a repo's config in its [mise tasks](/features/mise-tasks) tab. A task's worktree uses its own config only while the agent has not changed it.
- A secret the agent's tools get is like a token in your shell: the agent can print it in its terminal or write it to a file. List only what your tools need.
- Hiding a secret keeps it out of the agent's commands by accident, not from an agent that tries: it can run `mise env` or read your age key like any program you run.
- A bad name in `agentSecrets` stops sessions from starting until you fix it, so a typo never shows more than you meant.
- age encryption in mise is still experimental. See [mise's guide to age](https://mise.jdx.dev/environments/secrets/age.html) for keys on Windows and other options.
- Keep secrets out of `mise.local.toml` if you back it up with [Local config backup](/features/local-config), or keep them encrypted there.
