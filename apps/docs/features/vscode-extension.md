---
title: VS Code extension
description: See in VS Code which Trackwall session waits for you while you read other code, and open it in Trackwall with one click.
---

# VS Code extension

See in VS Code which Trackwall session waits for you while you read other code, and open it in Trackwall with one click.

## What you get

- A status bar item in VS Code that counts the sessions and task proposals waiting for you, in the warning colour, or the sessions that run.
- A "Trackwall" side bar with every session in "Waiting for you", "Running" and "Ended", each with its repo and its state in Trackwall's words.
- One click on a session opens it in Trackwall's window.
- The extension only reads: it cannot start, stop or answer a session, and it is off until you turn it on.

## How it works

The extension asks Trackwall on this computer what the sessions are doing, every two seconds while VS Code has the focus and every ten seconds while it does not. A session that asks for approval, waits for your plan or waits for your next prompt shows under "Waiting for you", and the status bar item turns yellow with how many wait.

Trackwall shares only what a glance needs: where each session works, its state, the title the agent gave its window and the title of a proposed task. What the agent asks you to approve, its terminal, your prompts and your messages stay in Trackwall. To answer, click the session: Trackwall's window opens on it.

The extension gets its own read-only token from Trackwall, separate from the one Trackwall's window uses. Trackwall writes it into `viewer.json` in its state folder while "VS Code extension" is on, gives it a new one at each start, and refuses it as soon as you turn the setting off.

## Use it

1. In Trackwall, open "Settings" (Ctrl+, or ⌘, on macOS), choose "App" and tick "Let the VS Code extension see the sessions" under "VS Code extension".
2. In VS Code, run "Extensions: Install from VSIX…" from the Command Palette and pick the `trackwall-<version>.vsix` file.
3. Look at the status bar: within two seconds it shows what waits for you. Click it to open the "Trackwall" side bar.
4. Click a session in the side bar to open it in Trackwall.

## Good to know

- The extension is not in the VS Code Marketplace yet: you install it from the `.vsix` file, which is built from the source with `pnpm --filter @trackwall/vscode package`.
- In a dev container, install the extension in the container's VS Code window: it then runs in the container, next to the Trackwall that runs there. A click on a session still opens Trackwall's window on your computer.
- When Trackwall keeps its state somewhere else than `.trackwall` in your home folder, set "Trackwall: State Folder" in VS Code's settings (or `TRACKWALL_HOME`), so the extension finds `viewer.json`. A folder set there that does not exist on the machine where the extension runs is ignored: VS Code also applies your settings from your computer in a dev container's window, and the extension in the container then looks in `TRACKWALL_HOME` or `.trackwall` in the container's home folder.
- While Trackwall does not share its sessions, the side bar names the `viewer.json` file it looked for, so you can check that it is the folder of the Trackwall you mean.
- The extension talks only to Trackwall on `127.0.0.1` of the machine it runs on, never through a proxy, and sends its token only to the Trackwall start that wrote it.
- Other VS Code extensions run in the same process and can read `viewer.json` like any program of yours; the token in it still only shows the sessions.
