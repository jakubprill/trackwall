---
title: Trackwall errors
description: Trackwall keeps its own errors on your computer, anonymized, with the place in its code each came from, so a problem can be looked into later.
---

# Trackwall errors

Trackwall keeps its own errors on your computer, anonymized, with the place in its code each came from, so a problem can be looked into later.

## What you get

- Errors of Trackwall itself, from the daemon, the desktop app and its windows, in one list in "Settings > Diagnostics".
- The same error counted once, with how many times and when it last happened, and the Trackwall version.
- For each error, the places in Trackwall's code it went through, such as `packages/daemon/src/api/server.ts:68`.
- Paths, your user and computer names, repo names, hosts and anything that looks like a token are replaced before an error is saved.
- An error from yesterday is still there after a restart.

## How it works

When something in Trackwall fails in a way it did not expect, it notes the error: an action of a view or an agent's tool that broke, an error in a window, a failed start, or something the desktop app could not do, such as setting the tray icon. Errors of your own code, your builds and your sessions are not Trackwall's and stay in their logs.

Before an error is saved, its message is anonymized. Your projects folder becomes `<projects>`, your home folder `<home>`, a repo `<repo>`, your computer `<host>`, and the same for your user name, other paths, web addresses, e-mail addresses and values that look like tokens. Places in Trackwall's own code stay as they are, because they say where to fix it.

"Trackwall errors" in "Settings > Diagnostics" lists the errors, newest first. Each shows which part of Trackwall it came from and where (for example "Daemon · /api/workspace/sync"), its kind, how many times it happened, when it last did and in which version, its message and the top three places in Trackwall's code.

## Use it

1. Open "Settings" (Ctrl+, or ⌘, on macOS), choose "Diagnostics" and find "Trackwall errors".
2. Read an error's message and its places in the code, or copy them into a bug report yourself.
3. Click "Clear" when you have dealt with the list.

## Good to know

- Nothing is sent anywhere. The list is `logs/errors.json` in Trackwall's state folder (`~/.trackwall`, on Windows `%USERPROFILE%\.trackwall`), and you decide what to share from it.
- Anonymization covers what Trackwall knows and what looks like a name, an address or a token. A name it cannot recognise, such as a client's name in a library's message, can stay, so read an error before you paste it anywhere.
- The list keeps the 100 errors seen most recently.
- The daemon's last start log is `logs/daemon-start.log`, and the one before it `logs/daemon-start.prev.log`.
