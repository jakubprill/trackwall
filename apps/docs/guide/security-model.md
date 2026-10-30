---
title: Security model
description: What keeps your computer, your repos and your secrets safe while agents work, and the gaps Trackwall knows about and leaves open today.
---

# Security model

What keeps your computer, your repos and your secrets safe while agents work, and the gaps Trackwall knows about and leaves open today.

Trackwall runs coding agents on your computer, with your files and your tokens. It does not try to sandbox them: an agent's commands run as you, like in your own terminal. What Trackwall does is keep you as the gate for anything that starts work or reaches outside, keep its own interfaces closed to anyone but you, and keep secrets out of places agents read.

## Only you reach the daemon

- The daemon listens only on `127.0.0.1`, so nothing else on the network can reach it.
- Every request needs a token. The daemon makes a fresh one at each start and keeps it in a file only your user can read; the desktop app hands it to the window.
- A request from a web page on another address is refused, even with the token, so a website you visit cannot talk to Trackwall through your browser.
- A session gets its own token, which opens only the MCP server and its own hooks, never the rest of the daemon.

## You are the gate

| An agent can | An agent cannot |
|---|---|
| Read your repos, the graph, logs and the list of sessions and tasks | Start a task: it proposes one, and nothing starts until you press "Start task" |
| Propose a task or the removal of a repo, and add ideas to the [plan](/features/plan) | Answer an approval, its own or another session's |
| Run a repo's mise tasks and services in its own repo or task worktree | Run a command line through Trackwall: tools take a repo, a task or a service by name, and the daemon builds the command from your config |
| Send messages to the tasks it proposed, up to five without you | Change Trackwall's settings, its connected agents or start at sign-in |
| Report its task's result | Trust a changed mise config: only you do, after you read the changes |

- **The supervisor** plans, it does not change code: it cannot run shell commands or write files unless you turn that on yourself.
- **An agent task** works in its own worktree, on its own branch, and is told not to push. You read its diff before anything leaves your computer, and its branch is pushed when you press "Push".
- **A changed mise config** in a task's worktree stops every mise task there until you read the changed files and press "Trust this config", so an agent cannot quietly add a command that the next run would execute.
- **Approvals** you answer from the tray press the same key you would press in the terminal, and only while the question you saw is still on the screen; a request asked after your click is not answered by it.

## Secrets stay out of reach

- Variables and tokens for sessions come from your mise config, where secrets can stay encrypted on disk. A secret reaches Copilot CLI itself, but its shell and tools only when you list the secret in `agentSecrets`. See [Environment from mise](/features/mise-environment).
- Values of secret variables are replaced with `***` before a log line is kept, so the logs view, the log files and the agents' log tools never see them.
- Tools that tell an agent about a variable answer "set" or "missing", never the value.
- Trackwall's own error journal is anonymized and never sent anywhere.

## Your repos are read, not run

Reading a repo for its card, the graph or code search runs nothing from it: Trackwall reads the files of the last commit straight from git, without building, without hooks and without the repo's programs, and with limits on size and time, so a strange repo cannot take over or stall Trackwall. A repo's code runs when you, or an agent you started, run one of its mise tasks, build it with the [Batch command](/features/batch-command) or work in it, and syncing runs what a `git pull` would (below).

## Gaps we know about

Being honest about these is part of the model:

- **An agent runs as you.** Its shell can read whatever you can, including the daemon's token file, and with that it could call the daemon like the window does. Trackwall narrows what an agent gets on purpose (its own token, no daemon token in its files), but it does not sandbox it.
- **"No approvals" means no approvals.** A task you start with the "No approvals" pill on runs every command without asking, a `git push` included. Use it for work you would let run unattended.
- **Syncing behaves like `git pull`.** It runs the hooks and helpers a repo's local git config names, as your terminal would.
- **Secrets a program finds by itself are not masked.** A value from a `.env` file or a password manager that a service prints reaches its log in plain text, as it reaches your terminal.
- **What the agent sends to its model** is Copilot CLI's business: Trackwall does not see or filter it.
