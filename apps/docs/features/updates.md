---
title: App updates
description: Trackwall tells you when a new version is out and installs it with one click, checked against the release signature.
---

# App updates

Trackwall tells you when a new version is out and installs it with one click, checked against the release signature.

## What you get

- A strip above the views when a newer version of Trackwall is released.
- "Update and restart": download, install and restart in one click, with every step on screen: the download with its size, share and speed, then the signature check, the install and the restart, with a note when the download has stalled, "Cancel" while it runs and "Try again" after a failure.
- Only updates signed by the Trackwall release key are installed.
- A copy of your tasks and the rest of Trackwall's state before a new version reads it, so going back to the older version brings them back.
- Nothing installs or restarts until you click, and "Update after their turn" waits until no agent is in the middle of a turn.

## How it works

Shortly after it starts, and then every few hours, the main window checks the latest release on GitHub. When there is a newer version, a strip above the views says "Trackwall `<version>` is available", with "Update and restart" and "Later". "Later" hides the strip until a newer version comes out or Trackwall starts again. While an agent is in the middle of a turn, working or waiting for you to approve a step or a plan, the strip says how many and offers "Update after their turn" and "Update now" instead of "Update and restart". "Update after their turn" says "Trackwall `<version>` installs once 2 agents finish their turn" and starts the install as soon as the last one ends; "Cancel" takes it back. When a newer version comes out meanwhile, it waits to install that one.

"Update and restart" downloads the update and shows where it is: "Connecting to download…", then "Downloading Trackwall `<version>`: 12.0 MB of 40.0 MB (30%), 2.1 MB/s" with a bar, then "Checking the signature…", "Installing…" and "Restarting into…". When no data arrives for 20 seconds, it says so under the bar. "Cancel" stops the download; once the package is in and checked, the install goes on to the end. After a cancel or an error, "Try again" starts over. Trackwall checks the signature before it changes anything, replaces its own files and starts again in the new version. The restart stops the services and Copilot CLI sessions that run in Trackwall, which is why it waits for your click.

"Settings > App" shows the version you run, what the last check found, the install as it goes and "Check for updates". An extra window checks only from there.

## Use it

1. When the strip appears, click "Update and restart", or "Update after their turn" while agents are working.
2. If an agent waits for your approval, answer it, or click "Update now" to update without waiting.

## Good to know

- On Windows the update replaces the files of the Trackwall folder and leaves your own files there alone. The old files stay in `.update` inside it until the next start removes them. The folder must be one you can write to, as `%LOCALAPPDATA%\Programs\Trackwall` is.
- On macOS the app in `/Applications` is replaced in place; if you cannot write to it, macOS asks for an administrator password.
- The download goes through the proxy from the system settings or `HTTPS_PROXY`. A proxy that asks for Windows sign-in or replaces certificates can stop it, and one that scans the file first can hold it for a long time with no data; "Settings > App" then shows the error or the stall, and the [manual update](/guide/install#update) still works.
- The restart stops the [sessions](/features/sessions), and the new version opens again the ones that were running, with their conversations. An agent in the middle of a turn loses that turn, which is why "Update after their turn" waits for it. The waiting is kept by the window where you clicked it; closing it to the tray is fine.
- An update keeps your tasks, sessions and queues: a newer version reads the files an older one left in `~/.trackwall`.
- Before another version reads those files, Trackwall copies them into `~/.trackwall/state-backups`, one folder per change of version, and keeps the last ten. Nothing is copied when you start the same version again.
- Going back to an older version, after an update you did not like, brings back what that version left: when the newer one wrote a file the older one cannot read, the older one puts back the whole copy it made when you updated, so your tasks, their rounds and verdicts match again. What the newer version left is in the copy taken on the way back. A file the older version reads as it is stays as the newer one left it.
- Without such a copy, as when you go back to a version from before copies, the older version sets each file it cannot read aside as `<file>.newer-<time>` in `~/.trackwall` and starts with that part empty. Rename the file back after you update again.
- To go back to a copy by hand, quit Trackwall and copy the files of a folder in `~/.trackwall/state-backups` into `~/.trackwall`; its `backup.json` says which version wrote them and when.
- The browser mode (`trackwall-daemon --ui`) has no updates.
