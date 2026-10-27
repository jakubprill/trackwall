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

- The command adds a `trackwall` entry to `~/.copilot/mcp-config.json` (on Windows `%USERPROFILE%\.copilot\mcp-config.json`). "Settings > Agents" also shows the entry as JSON, in case you prefer to paste it there by hand.
- The entry holds no password or token: it finds the running Trackwall by itself, so it keeps working after a restart.
- Trackwall must be running before a Copilot CLI session starts, because Copilot CLI connects to its MCP servers when a session starts.
- Trackwall also tells the agent when to reach for which tool. Sessions started from "Sessions" get this guidance with their [session instructions](/features/session-instructions); in a session you start yourself, Copilot CLI uses it only when started as `copilot --allow-all-mcp-server-instructions`, which accepts it from every connected MCP server.

## Other MCP clients

An MCP client that speaks HTTP can connect to `http://127.0.0.1:<port>/mcp` with the header `Authorization: Bearer <token>`. The port and token are in `daemon.json` in the state directory (`~/.trackwall`) and change every time Trackwall starts, so the command above is the simpler way.
