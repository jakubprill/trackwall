---
title: Connect Copilot CLI
description: Connect Copilot CLI to the Trackwall MCP server once, and every session can use it.
---

# Connect Copilot CLI

Connect Copilot CLI to the Trackwall MCP server once, and every session can use it.

Once connected, an agent can answer questions like "Which repos are in my projects folder?" or "Who calls orders-api?" from what Trackwall knows, and use the rest of the [MCP server](/features/mcp) tools.

## Connect

1. Start Trackwall.
2. Open "Settings > Agents" (Ctrl+, or ⌘, on macOS) and copy the command shown there. It is ready for your installation and looks like this:

   ```sh
   copilot mcp add trackwall -- /Applications/Trackwall.app/Contents/MacOS/trackwall-daemon mcp-stdio                     # macOS
   copilot mcp add trackwall '--' '<Trackwall directory>\trackwall-daemon.exe' mcp-stdio    # Windows (PowerShell; `--` in single quotes)
   ```

3. Run it once in a terminal.
4. Start Copilot CLI and type `/mcp`: the `trackwall` server shows as connected.

## Good to know

- The command adds a `trackwall` entry to `~/.copilot/mcp-config.json` (on Windows `%USERPROFILE%\.copilot\mcp-config.json`). "Settings > Agents" also shows the entry as JSON under "Or add an entry to", in case you prefer to paste it there by hand.
- The entry holds no password or token: it finds the running Trackwall by itself, so it keeps working after a restart.
- Trackwall must be running before a Copilot CLI session starts, because Copilot CLI connects to its MCP servers when a session starts.
- Trackwall also tells the agent when to reach for which tool. Sessions started from "Sessions" get this guidance with their [session instructions](/features/session-instructions); in a session you start yourself, Copilot CLI uses it only when started as `copilot --allow-all-mcp-server-instructions`, which accepts it from every connected MCP server.

## Other MCP clients

Any MCP client, such as an editor's agent or another coding agent, can use the same server. Add it to the client as a server that the client starts and talks to over stdio, with the `command` and `args` from the JSON entry in "Settings > Agents"; leave out its `type` and `tools` keys, which only Copilot CLI reads. In a client configured with JSON this usually looks like:

```json
{
  "mcpServers": {
    "trackwall": {
      "command": "<command from Settings > Agents>",
      "args": ["mcp-stdio"]
    }
  }
}
```

The exact keys depend on the client. A client that speaks HTTP can instead connect to `http://127.0.0.1:<port>/mcp` with the header `Authorization: Bearer <token>`. The port and token are in `daemon.json` in the state directory (`~/.trackwall`) and change every time Trackwall starts, so the command is the simpler way.

### What works from another client

An agent in another client is not a Trackwall session, so it gets what Trackwall knows, but not the parts that belong to a session in "Sessions". Like a session you start yourself, it gets Trackwall's guidance on the tools only if the client accepts instructions from MCP servers (see above).

| Works | Does not work |
|---|---|
| Repos, cards, code and commit search, the connection graph and endpoints | Reading a task's review comments, messages or handoff, asking a task's proposer a question and reporting a task's result: only the agent of a task in "Sessions" does that |
| Logs, errors, test results and a Spring app's configuration | Sending messages to a task's agent and getting updates about tasks: follow a task with `wait_for_session` instead |
| Running and stopping mise tasks and services, calling endpoints, verifying a task | Asking you to copy text, and state, approvals and notifications in the app for that agent: Trackwall does not see its terminal |
| Proposing tasks and changes, waiting for sessions, resuming a task | |
| Your plan, routines and workspace knowledge | |

### What it is allowed to do

An agent in another client counts as you, like a program in your own terminal. Unlike a session in "Sessions", it can run mise tasks and services in every repo and every task's worktree, still only with a mise configuration you have trusted; when it is refused for an untrusted one, it is not told when you trust it later. What no agent can do is on the [MCP server](/features/mcp) page. Its calls show in [MCP calls](/features/mcp-calls) as an agent outside Trackwall. Connect only clients you would let run commands in your repos.
