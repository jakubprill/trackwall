---
title: Connect Copilot CLI
description: Connect Copilot CLI to the Trackwall MCP server once, and every session can use it.
---

# Connect Copilot CLI

Connect Copilot CLI to the Trackwall MCP server once, and every session can use it.

Copilot CLI starts Trackwall's MCP bridge (`trackwall-daemon mcp-stdio`) as a local MCP server. The bridge finds the running Trackwall by itself, so you connect once, and the configuration holds no token. The ready command for your installation is in the "Daemon" view (Ctrl+9, copy button). It looks like this:

```sh
copilot mcp add trackwall -- /Applications/Trackwall.app/Contents/MacOS/trackwall-daemon mcp-stdio                     # macOS
copilot mcp add trackwall '--' '<Trackwall directory>\trackwall-daemon.exe' mcp-stdio    # Windows (PowerShell; `--` in single quotes)
```

The command adds a `trackwall` entry to `~/.copilot/mcp-config.json` (on Windows `%USERPROFILE%\.copilot\mcp-config.json`; the same entry in JSON is in the "Daemon" view, in case it needs to be pasted by hand). Trackwall must be running before Copilot CLI starts, because Copilot starts MCP servers at session start; `/mcp` in Copilot CLI shows whether the `trackwall` server is connected. Then it is enough to ask the agent, for example, "Which repos are in my projects folder?". The MCP server also gives an instruction on when to reach for which tool, but Copilot CLI 1.0.103 takes such instructions only from servers on its own allowlist; in a session started outside Trackwall you can turn it on with `copilot --allow-all-mcp-server-instructions` (which turns on the instructions of every connected MCP server). Sessions from the "Sessions" view get it without that.

Other MCP clients can also talk to the daemon directly through Streamable HTTP at `http://127.0.0.1:<port>/mcp` with the header `Authorization: Bearer <token>`; the port and token are in `daemon.json` in Trackwall's state folder (`~/.trackwall`) and change every time Trackwall starts.
