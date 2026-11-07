---
title: Security model
description: What keeps your computer, your repos and your secrets safe while agents work, and the gaps Trackwall knows about and leaves open today.
---

# Security model

What keeps your computer, your repos and your secrets safe while agents work, and the gaps Trackwall knows about and leaves open today.

Trackwall runs coding agents on your computer, with your files and your tokens. An agent's commands run as you, like in your own terminal, except in an agent task without approvals, whose commands run in Copilot CLI's sandbox on Linux, and on macOS and Windows when you turn it on. What Trackwall does is keep you as the gate for anything that starts work or reaches outside, keep its own interfaces closed to anyone but you, and keep secrets out of places agents read.

## Only you reach the daemon

- The daemon listens only on `127.0.0.1`, so nothing else on the network can reach it.
- Every request needs a token. The daemon makes a fresh one at each start and keeps it in a file only your user can read; the desktop app hands it to the window.
- A request from a web page on another address is refused, even with the token, so a website you visit cannot talk to Trackwall through your browser.
- A website cannot show Trackwall's page inside its own, so it cannot trick you into a click on an approval there.
- A session gets its own token, which opens only the MCP server and its own hooks, never the rest of the daemon.
- The [VS Code extension](/features/vscode-extension) gets its own read-only token too, and only after you turn it on: it shows what the sessions are doing and opens nothing else.

## You are the gate

| An agent can | An agent cannot |
|---|---|
| Read your repos, the graph, logs and the list of sessions and tasks | Start a task: it proposes one, and nothing starts until you press "Start task" |
| Propose a task or the removal of a repo, and add ideas to the [plan](/features/plan) | Answer an approval, its own or another session's |
| Run its own repo's mise tasks, and start its service with the services it calls (a session in a repo or a task) | Run a command line through Trackwall: tools take a repo, a task or a service by name, and the daemon builds the command from your config |
| Send messages to the tasks it proposed, up to five without you | Change Trackwall's settings, its connected agents or start at sign-in |
| Report its task's result | Trust a mise config a task changed: only you do, after you read the changes |

- **The supervisor** plans, it does not change code: it cannot run shell commands or write files unless you turn that on yourself (see [Supervisor](/features/supervisor)).
- **An agent task** works in its own worktree, on its own branch, and is told not to push. You read its diff, and you push its branch with "Push". Being told is an instruction, not a lock: see the gaps below.
- **A task without approvals** runs its commands in Copilot CLI's sandbox: a command, or a build or script it starts, can write only in the task's worktree and the repo's git folder, and cannot read your other repos or credential folders such as `~/.ssh`. Where the sandbox cannot run, Trackwall refuses to start such a task rather than start it without it. In a container the sandbox is off until the container is set up for it ([dev container guide](/guide/dev-container#copilot-cli-s-sandbox)), and until then such a task can read everything in the container; on macOS and Windows it is off until you turn it on. See [Approvals](/features/approvals).
- **A changed mise config** in a task's worktree stops every mise task there until you read the changed files and press "Trust this config", so a task's agent cannot quietly add a command that the next run in its worktree would execute.
- **Approvals** you answer from the tray press the same key you would press in the terminal, and only while the question you saw is still on the screen; a request asked after your click is not answered by it.
- **What agents did** through Trackwall is on record: every tool call, with the agent that made it, the repo, task or mise task it named and how it ended, is in [MCP calls](/features/mcp-calls). Only names are kept, never a prompt, a message or a request body.

## Secrets stay out of the way

- Variables and tokens for sessions come from your mise config, where secrets can stay encrypted on disk. A secret reaches Copilot CLI itself, but by default not the commands it runs: its shell and tools get only the secrets you list in `agentSecrets`. This keeps a secret from slipping into a command or a log by accident; it does not stop an agent that goes looking for it (see the gaps below). See [Environment from mise](/features/mise-environment).
- Values of variables with secret names (`TOKEN`, `PASSWORD`, `API_KEY` and the like), and values mise marks as secret, are replaced with `***` before a log line is kept, so the logs view, the log files and the agents' log tools do not see them.
- Tools that tell an agent about a variable answer "set" or "missing", never the value.
- Trackwall's own error journal is anonymized as far as Trackwall can, and never sent anywhere.

## Your repos are read, not run

Reading a repo for its card, the graph or code search runs nothing from it: Trackwall reads the files of the last commit straight from git, without building, without hooks and without the repo's programs, and with limits on size and time, so a strange repo cannot take over Trackwall and can hold it up only briefly. A repo's code runs when you, or an agent you started, run one of its mise tasks, build it with the [Batch command](/features/batch-command) or work in it, and syncing runs what a `git pull` would (below).

What Trackwall shows from a repo, such as a README with its diagrams, cannot load anything from the internet, in the desktop window and in a browser tab alike: an image becomes its description, so a README cannot tell anyone that you opened it.

## Gaps we know about

Being honest about these is part of the model:

- **An agent runs as you.** Its shell can read whatever you can, including the daemon's token file, and with that it could call the daemon like the window does; its calls through that token show in [MCP calls](/features/mcp-calls) as an agent outside Trackwall, not as its session. Trackwall narrows what an agent gets on purpose (its own token, no daemon token in its files), but only a task without approvals runs in a sandbox.
- **"No approvals" means no approvals.** A task you start with the "No approvals" pill on runs every command without asking, a `git push` included. The sandbox keeps its commands in the worktree, but not off the network, and the system's temporary folder is open to them; files it changes with Copilot CLI's own edit tool are kept in the worktree by Copilot CLI's checks, not by the system. The repo's git folder stays writable, so a misled agent could leave a git hook that runs outside the sandbox, and what Trackwall runs for the task (Verify, services) runs outside it on the files the agent changed. Use it for work you would let run unattended.
- **A session's own repo config is trusted by its path.** mise trusts a config file by where it is, not by what it says. A session working in a repo's own folder (not a task) can edit the repo's trusted `mise.toml`, and the next mise task it runs through Trackwall runs the edited command.
- **Hidden secrets can still be found.** An agent's shell runs as you, so it can ask mise for the environment itself or read your mise key; keeping secrets out of its commands is about accidents, not about a determined agent.
- **Syncing behaves like `git pull`.** It runs the hooks and helpers a repo's local git config names, as your terminal would.
- **Secrets a program finds by itself are not masked.** A value from a `.env` file, a password manager, or a plain mise `[env]` entry with an ordinary name that a service prints reaches its log in plain text, as it reaches your terminal.
- **What the agent sends to its model** is Copilot CLI's business: Trackwall does not see or filter it.
