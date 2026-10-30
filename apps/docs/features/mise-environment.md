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
- The session panel and its tile in the grid show which variables a session got, never their values, and the panel says when a change to your config has not reached a running session yet.

## How it works

mise reads every config from the folder a session works in up through the projects folder, so a `mise.toml` in the projects folder applies to every repo in it, and a repo's own `mise.toml` adds to it or overrides it. When Trackwall starts a session, it asks mise for that environment and gives it to Copilot CLI over your own. A session in a repo gets the repo's environment, an [agent task](/features/tasks) gets its worktree's, and the [supervisor](/features/supervisor) and a free session get the projects folder's. [Where agents work](/guide/where-agents-work) draws these layers, and [Environment variables](/guide/environment-variables) lists every variable a session gets.

A value you write with `mise set --age-encrypt` sits in the file encrypted, and mise decrypts it with your age key. mise marks such values, and those you mark with `redact = true`, as secrets; Trackwall also treats a variable whose name looks like a secret (`GITLAB_TOKEN`, `DB_PASSWORD`) as one. Copilot CLI itself has every variable, but the agent's shell and its local MCP servers do not get the secrets unless you list them in `agentSecrets`. A secret never shows in a mise task's log or in the last lines of an ended session: Trackwall replaces it with `***`.

Under the session's header a line says how many variables it got from mise, which secrets are hidden from the agent's tools and which they get; click the number to see every name. In the grid, where there is less room, a key with the number sits next to the session's title: hover it to see the names in the same groups, or click it to keep them open. It turns yellow when something is missing. When mise cannot give the environment where the session works, for example because the repo's config is not trusted yet or the age key is missing, the line says why, and the session gets the environment of the folder above it instead. If `MISE_AGE_KEY` is in your own environment, the agent's tools do not get it either.

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

6. Start a session: the line under its header, or the key on its tile in the grid, lists what it got.

### Use another model provider

Copilot CLI can talk to another model provider instead of your GitHub account, for example a local proxy that speaks the OpenAI API. A session profile switches sessions over without touching mise tasks, services or Trackwall itself.

1. In your projects folder, create `mise.byok.toml` with the provider's settings, and its key encrypted:

   ```toml
   [env]
   COPILOT_OFFLINE = "true"
   COPILOT_PROVIDER_BASE_URL = "http://127.0.0.1:4000/v1"
   COPILOT_MODEL = "your-model"
   ```

   Add the key with `mise set --age-encrypt --stdin -E byok COPILOT_PROVIDER_API_KEY` in the same folder, and trust the file with `mise trust mise.byok.toml`.
2. In "Settings > Agents > Session profile", type `byok` and click "Save".
3. Start a session: the line under its header says "profile byok". Every `COPILOT_PROVIDER_*` variable counts as a secret, so the key and the address are hidden from the agent's tools and masked in what Trackwall keeps; the address shows as `***` in logs too.

Sessions that were already running show "The environment from mise changed": **Restart to apply** moves them over. To go back to your GitHub account, click "No profile"; nothing needs a restart of Trackwall.

## Good to know

- It needs `mise` on your `PATH`. Without it sessions start with your own environment only.
- If you start Trackwall with `MISE_ENV` set, sessions read that environment and then the profile, so the profile wins where both set a variable. A session profile is a plain name such as `byok`. mise reads `mise.<profile>.toml` wherever it reads `mise.toml`, so a repo's own `mise.byok.toml` applies to sessions in that repo too, once you trust it. A name in `workspace.yaml` that is not a plain name stops sessions from starting until you fix it.
- Trackwall reads the environment when a session starts, since Copilot CLI cannot take a new one while it runs. When `mise.toml` or `agentSecrets` changes, a running session shows "The environment from mise changed" with the names that are new, changed or removed (never the values). **Restart to apply** stops the session and starts it again with the same conversation: a free session, a session in a repo, a task and the supervisor alike. The button waits while the agent is in the middle of a turn. Trackwall checks every 15 seconds while the panel is open.
- Only the configs from where a session works up to the projects folder count. In a monorepo, a `mise.toml` or `mise.local.toml` in a package folder below the repo root does not reach the session, even though `mise env` in that folder shows its variables. Put what a session needs into the config at the repo root, and build paths with `{{config_root}}`, the folder of the file that sets them: `CLIENT_CERT = "{{config_root}}/packages/orders/certs/client.pem"`.
- A config mise does not trust is never trusted for you: trust a repo's config in its [mise tasks](/features/mise-tasks) tab. A task's worktree uses its own config only while the agent has not changed it.
- A secret the agent's tools get is like a token in your shell: the agent can print it in its terminal or write it to a file. List only what your tools need.
- Hiding a secret keeps it out of the agent's commands by accident, not from an agent that tries: it can run `mise env` or read your age key like any program you run.
- A bad name in `agentSecrets` stops sessions from starting until you fix it, so a typo never shows more than you meant.
- age encryption in mise is still experimental. See [mise's guide to age](https://mise.jdx.dev/environments/secrets/age.html) for keys on Windows and other options.
- Keep secrets out of `mise.local.toml` if you back it up with [Local config backup](/features/local-config), or keep them encrypted there.
