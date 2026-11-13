---
title: trackwall:// links
description: Links that open a repo, session or task in Trackwall, from an agent's answer or anywhere else.
---

# trackwall:// links

Links that open a repo, session or task in Trackwall, from an agent's answer or anywhere else.

## What you get

- A link to any repo, session or task that opens it in Trackwall.
- Agents that point you to the right place in their answers.
- Links that only show: they never start, stop or approve anything.

## How it works

`trackwall://repo/<repo id>` opens the repo in "Repos"; `trackwall://session/<session id>` and `trackwall://task/<task id>` open the session or task in "Sessions" (a task link also opens a task proposal). If Trackwall is not running, the link starts it.

Agents connected to the [MCP server](/features/mcp) know the format, so a session can put such a link in its answer. In a session shown as a conversation, the link is underlined and opens with a plain click, whether the agent writes it as a named link (`[orders](trackwall://repo/orders)`), as bare text or in backticks; the same goes for links in a README. In a session terminal, Ctrl+click (Cmd+click on macOS) opens it, also when the agent's answer breaks it over several rows or shows it as a named link (a Markdown link like `[orders](trackwall://repo/orders)`). Web links that the agent shows as named links open in your browser the same way. Links work the same in the desktop app and in Trackwall opened in a browser tab. A link Trackwall does not recognise just brings its window forward, and inside Trackwall it stays plain text.

## Use it

1. Start Trackwall once, so the system knows the links.
2. Click a `trackwall://` link in a conversation, Ctrl+click one in a session terminal, or open one from anywhere else.

## Good to know

- A link to a session or task that Trackwall does not have, because it ended or the link comes from Trackwall running somewhere else (such as in a dev container), shows a message saying so and leaves the selection as it was.
- On macOS the system learns the links the first time you start the app.
- On Windows the portable `trackwall.exe` registers the links for your user every time it starts. After moving the folder, start Trackwall once from the new place; with two copies, the one started last gets the links.
