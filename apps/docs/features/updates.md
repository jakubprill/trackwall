---
title: App updates
description: Trackwall tells you when a new version is out and installs it with one click, checked against the release signature.
---

# App updates

Trackwall tells you when a new version is out and installs it with one click, checked against the release signature.

## What you get

- A strip above the views when a newer version of Trackwall is released.
- "Update and restart": download, install and restart in one click, with every step on screen: the download with its size, share and speed, then the signature check, the install and the restart.
- A note when the download has stalled, "Cancel" while it runs and "Try again" after a failure.
- Only updates signed by the Trackwall release key are installed.
- Nothing installs or restarts until you click.

## How it works

Shortly after it starts, and then every few hours, the main window checks the latest release on GitHub. When there is a newer version, a strip above the views says "Trackwall `<version>` is available", with "Update and restart" and "Later". "Later" hides the strip until a newer version comes out or Trackwall starts again.

"Update and restart" downloads the update and shows where it is: "Connecting to download…", then "Downloading Trackwall `<version>`: 12.0 MB of 40.0 MB (30%), 2.1 MB/s" with a bar, then "Checking the signature…", "Installing…" and "Restarting into…". When no data arrives for 20 seconds, it says so under the bar. "Cancel" stops the download; once the package is in and checked, the install goes on to the end. After a cancel or an error, "Try again" starts over. Trackwall checks the signature before it changes anything, replaces its own files and starts again in the new version. The restart stops the services and Copilot CLI sessions that run in Trackwall, which is why it waits for your click.

"Settings > Updates" shows the version you run, what the last check found, the install as it goes and "Check for updates". An extra window checks only from there.

## Use it

1. When the strip appears, finish or stop what runs in Trackwall.
2. Click "Update and restart".

## Good to know

- On Windows the update replaces the files of the Trackwall folder and leaves your own files there alone. The old files stay in `.update` inside it until the next start removes them. The folder must be one you can write to, as `%LOCALAPPDATA%\Programs\Trackwall` is.
- On macOS the app in `/Applications` is replaced in place; if you cannot write to it, macOS asks for an administrator password.
- The download goes through the proxy from the system settings or `HTTPS_PROXY`. A proxy that asks for Windows sign-in or replaces certificates can stop it, and one that scans the file first can hold it for a long time with no data; "Settings > Updates" then shows the error or the stall, and the [manual update](/guide/install#update) still works.
- The restart stops the [sessions](/features/sessions), and the new version opens again the ones that were running, with their conversations. An agent in the middle of a turn loses that turn, so update when the agents wait for you.
- The browser mode (`trackwall-daemon --ui`) has no updates.
