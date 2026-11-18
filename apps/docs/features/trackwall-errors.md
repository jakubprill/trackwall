---
title: Trackwall errors
description: Trackwall keeps its own errors on your computer, anonymized, with the place in its code each came from, so a problem can be looked into later.
status: stable
---

# Trackwall errors

Trackwall keeps its own errors on your computer, anonymized, with the place in its code each came from, so a problem can be looked into later.

## What you get

- Errors of Trackwall itself, from the daemon, the desktop app and its windows, in one list in "Settings > Diagnostics".
- The same error counted once, with how many times and when it last happened, the Trackwall version and the places in Trackwall's code it went through, such as `packages/daemon/src/api/server.ts:68`.
- Paths, your user and computer names, repo names, hosts and anything that looks like a token are replaced before an error is saved.
- "Copy diagnostics" puts everything a bug report needs on the clipboard in one go, anonymized the same way.

## How it works

When something in Trackwall fails in a way it did not expect, it notes the error: an action of a view or an agent's tool that broke, an error in a window, a failed start, or something the desktop app could not do, such as setting the tray icon. Errors of your own code, your builds and your sessions are not Trackwall's and stay in their logs.

Before an error is saved, its message is anonymized. Your projects folder becomes `<projects>`, your home folder `<home>`, a repo `<repo>`, your computer `<host>`, and the same for your user name, other paths, web addresses, e-mail addresses and values that look like tokens. Places in Trackwall's own code stay as they are, because they say where to fix it.

"Trackwall errors" in "Settings > Diagnostics" lists the errors, newest first. Each shows which part of Trackwall it came from and where (for example "Daemon · /api/workspace/sync"), its kind, how many times it happened, when it last did and in which version, its message and the top three places in Trackwall's code.

"Copy diagnostics" above the list runs the [doctor](/features/doctor) again and copies one text: the Trackwall version, the system the daemon runs on, every check of the doctor with its fix, and these errors. The doctor's lines name your folders and hosts, so they are anonymized like the errors before they reach the clipboard.

## Use it

1. Open "Settings" (Ctrl+, or ⌘, on macOS), choose "Diagnostics" and find "Trackwall errors".
2. Read an error's message and its places in the code.
3. For a bug report, click "Copy diagnostics", paste the text into the report's "Diagnostics" field and read it once before you send it.
4. Click "Clear" when you have dealt with the list.

## Good to know

- An error from yesterday is still there after a restart.
- Nothing is sent anywhere. The list is `logs/errors.json` in Trackwall's state folder (`~/.trackwall`, on Windows `%USERPROFILE%\.trackwall`), and you decide what to share from it.
- Anonymization covers what Trackwall knows and what looks like a name, an address or a token. A name it cannot recognise, such as a client's name in a library's message, can stay, so read an error before you paste it anywhere.
- The list keeps the 100 errors seen most recently.
- The daemon's last start log is `logs/daemon-start.log`, and the one before it `logs/daemon-start.prev.log`.
- When Trackwall feels slow, look in that log for lines starting with `[git]`: every git call that took 5 seconds or more is there, with the repo and how long it waited for its turn.
