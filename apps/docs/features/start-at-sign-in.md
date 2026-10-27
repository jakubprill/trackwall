---
title: Start at sign-in
description: Have Trackwall start hidden in the tray when you sign in, so your repos and agents are ready before you open it.
---

# Start at sign-in

Have Trackwall start hidden in the tray when you sign in, so your repos and agents are ready before you open it.

## What you get

- Trackwall running in the tray from the moment you sign in, without a window popping up.
- Repos watched, cards warmed up and notifications on before you open Trackwall.
- Your windows back on their monitors the first time you open it.

## How it works

Tick "Start Trackwall when I sign in" in "Settings > App". From then on, every time you sign in, Trackwall starts with only its tray icon. The daemon starts, watches your projects folder and shows a notification when an agent needs you, as it does with the window open.

Open Trackwall from the tray, with a double click on the icon on Windows, or by starting it again. The main window shows, and the extra windows you had open come back on their monitors with their views.

Trackwall keeps no copy of the setting: it adds itself to the system's own list of apps that start at sign-in, and the switch shows what Trackwall finds there.

## Use it

1. Open "Settings" (Ctrl+, or ⌘, on macOS).
2. Choose "App", and under "Start at sign-in" tick "Start Trackwall when I sign in".
3. Sign out and in again: the Trackwall icon is in the tray.

## Good to know

- On Windows it is a "Trackwall" entry in "Task Manager > Startup apps"; turning it off there turns it off in Settings too. No administrator rights are needed.
- On macOS it is a launch agent in `~/Library/LaunchAgents`, listed under "System Settings > General > Login Items". Turning it off there stops it, but Settings in Trackwall still shows it ticked; untick it in Trackwall instead.
- On macOS, logging out with "Reopen windows when logging back in" ticked also reopens Trackwall the usual way, with its windows.
- On macOS, Trackwall started from Downloads or a disk image runs from a temporary copy and cannot start at sign-in; move it to Applications first.
- On Windows, an entry an administrator set for every user of the computer cannot be turned off here; Settings says so.
- After an update, Trackwall restarts with its windows, also when it was started at sign-in.
- Each start points the entry at the Trackwall you started, so after moving the Trackwall folder, start it once from the new place.
- On macOS, a Trackwall in a folder whose path contains `&`, `<` or `>` cannot start at sign-in; Settings says so.
- The browser mode (`trackwall-daemon --ui`) does not start at sign-in.
