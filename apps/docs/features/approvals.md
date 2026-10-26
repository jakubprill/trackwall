---
title: Approvals outside the terminal
description: Approve or stop an agent's command from the tray panel or the Home dashboard, and let safe commands through without asking at all.
---

# Approvals outside the terminal

Approve or stop an agent's command from the tray panel or the Home dashboard, and let safe commands through without asking at all.

![The tray panel with an agent asking to run the tests: the command, the question and the buttons Yes, Yes and don't ask again, and Stop the agent](/screenshots/tray-panel.png)

## What you get

- Copilot CLI's approval requests in the tray panel and on the Home dashboard, with the command or file the agent asks about.
- One click to answer: the same options Copilot CLI offers in its terminal, or "Stop the agent".
- The agent's questions in the same places, so you know what it asks before you open its session.
- Commands you always allow, or never allow, written once for your repos instead of answered in every session.

## How it works

When an agent asks for approval, for example to run `mvn test` or to write a file outside its folder, its session shows "asking for approval" as before. Trackwall also reads the request from the session's screen and shows it outside the terminal: at the top of the tray panel, and on the [Home dashboard](/features/home) when you select the session. You see what the agent wants to do, the question Copilot CLI asks, and its answers as buttons: "Yes", and "Yes, and don't ask again" for that command or for file changes in this repo.

A click answers in the session's terminal, exactly as if you pressed the key there, and the agent goes on. "Stop the agent" is Esc: the agent ends its turn and waits for you. The terminal keeps working at the same time, so you can still answer there. If you did, or the agent has asked something else meanwhile, or asked the same thing again, the button says the request is no longer there and types nothing.

When the agent asks a question of its own (Copilot CLI's form with "Copilot needs information."), the panel and Home show the question, and "Answer in the session" opens its terminal, since the answer is yours to type.

For commands you never want to be asked about, or never want to run, add rules under `toolPermissions` in `~/.trackwall/workspace.yaml` (you edit this file by hand). Every new session gets them as Copilot CLI's own approval rules: an allowed command runs without a question, a denied one is refused, and a denial always wins.

```yaml
toolPermissions:
  - allow: ["shell(git status)", "shell(git diff)"]   # every session
  - repos: ["orders-*", "payments"]                   # only these repos
    allow: ["shell(mvn:*)", "shell(./mvnw:*)"]
    deny: ["shell(git push)"]
```

## Use it

1. Start a [session](/features/sessions) or an [agent task](/features/tasks) and let the agent work.
2. When it asks for approval, click the Trackwall icon in the tray.
3. Read the command and click "Yes", "Yes, and don't ask again" or "Stop the agent".

## Good to know

- A pattern is `kind` or `kind(argument)`, the same as Copilot CLI's `--allow-tool`: `shell(git push)` for one command, `shell(mvn:*)` for a command with any arguments, `write` for every file change, `trackwall(get_repo)` for a tool of an MCP server. `copilot help permissions` lists them all.
- A rule with `repos` applies to sessions whose repo name matches one of the patterns (`*` is any text, the case does not matter); a rule without `repos` applies to every session, the [supervisor](/features/supervisor) included.
- Rules apply to sessions started after you save the file. A mistake in `toolPermissions` stops new sessions from starting, with a message that names the problem, so a denial you wrote is never silently dropped.
- "Yes, and don't ask again" is remembered by Copilot CLI for the folder the session runs in. Each agent task has its own folder, so for something every task of a repo may do, add a rule instead.
- If you move the selection in the terminal to "No, and tell Copilot what to do differently", the buttons disappear until the agent asks again, so a click cannot type into the text you are writing there.
- Answering from outside the terminal is for approvals only. The option "No, and tell Copilot what to do differently" needs text, so it stays in the terminal.
- Trackwall reads requests in the layout of Copilot CLI 1.0.103. A request it cannot read is still in the terminal and still makes the session "asking for approval", it only has no buttons.
- A request taller than the session's terminal, such as the arguments of an MCP tool on a small screen, loses its top in the terminal. Trackwall still shows its buttons, with Copilot CLI's short description ("Use MCP tool: …") as the heading and only the part of the request the terminal shows.
- Agents connected to the [MCP server](/features/mcp) never see these requests and cannot answer them.
