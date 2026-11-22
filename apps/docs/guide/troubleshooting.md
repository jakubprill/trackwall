---
title: Troubleshooting
description: The problems people meet while setting Trackwall up, what each message means and what fixes it.
---

# Troubleshooting

The problems people meet while setting Trackwall up, what each message means and what fixes it.

Start with "Get started" for a first session (at the top of "Sessions" until you have one, and always in "Settings > Get started"), or "Settings > Diagnostics" for everything else: the [doctor](/features/doctor) there names most of the problems below with the fix for your computer, and "Check again" shows whether the fix worked. This page explains the fixes it points to and covers what it cannot see.

## Windows or macOS will not open Trackwall

SmartScreen blocks `trackwall.exe`, or macOS says Trackwall "is damaged": the builds are not signed yet, and a browser marks the archive it downloads. Download it as [Install](/guide/install) shows, or on Windows run `Unblock-File <file.zip>` before unpacking an archive you already have.

## The window says the daemon did not start

The window shows the reason and the end of the daemon's start log, which is also in `logs/daemon-start.log` in Trackwall's state folder (`~/.trackwall`, on Windows `%USERPROFILE%\.trackwall`).

- **"trackwall-daemon not found next to the app"**: the archive was not unpacked whole. Unpack all of it into one folder, as [Install](/guide/install) shows.
- **"The daemon exited during startup"** or **"did not respond within"**: read the log under the message. An antivirus that holds or removes `trackwall-daemon` is a common cause; ask to have the app folder allowed, then click "Try again".
- **"Trackwall daemon X is running (pid N), but this app is Y"**: a daemon of another version still runs, usually after you replaced the app folder without choosing "Quit" in the tray first. End the process `trackwall-daemon` with that pid (on Windows in Task Manager under "Details", on macOS in Activity Monitor or with `kill N`), then click "Try again".

## Copilot CLI is not found

"Get started" or the doctor says `Copilot CLI (copilot) not found in PATH`. Trackwall starts `copilot` from the `PATH` it started with.

1. Install Copilot CLI as [Install](/guide/install#copilot-cli) shows, if `copilot --version` does not answer in a new terminal.
2. Choose "Quit" in Trackwall's tray menu and start it again: a program you install while Trackwall runs is not in the `PATH` it started with. On macOS, Trackwall takes `PATH` from your login shell, so a `copilot` your terminal finds, for example from Homebrew or mise, is found too.
3. Click "Check again".

The same goes for Git and mise: install them, restart Trackwall, check again.

## A session says Copilot CLI is not signed in

Trackwall does not check the sign-in; a session that cannot sign in says so in its terminal. Sign in once in a terminal: run `copilot`, type `/login` and follow the steps. Sessions started in Trackwall then use that sign-in. In a dev container, use `copilot login --device-code` instead, as [Run in a dev container](/guide/dev-container) shows.

Copilot CLI also accepts a fine-grained personal access token with the "Copilot Requests" permission in `GH_TOKEN` or `GITHUB_TOKEN`. Set as a variable for Trackwall, it reaches every session and mise task, so prefer `/login`.

## Copilot CLI asks to trust every repo

Each new session or task stops with Copilot CLI's question whether it may work in the folder, because Copilot CLI trusts folders one by one. Click "Trust folder" in the step "Copilot CLI trusts your projects folder" of [Get started](/features/get-started), and Trackwall adds your projects folder for you. To do it by hand, add your projects folder to `trustedFolders` in Copilot CLI's `config.json` (`~/.copilot/config.json`, on Windows `%USERPROFILE%\.copilot\config.json`, or the folder `COPILOT_HOME` names), keeping the keys already there:

```json
{
  "trustedFolders": ["/Users/you/Projects", "C:\\Users\\you\\Projects"]
}
```

Write the folder as the doctor's "Copilot CLI trusted folder" line names it; on Windows each `\` is written `\\`. Task worktrees in the projects folder are covered by it; a task worktrees folder you chose elsewhere needs its own entry.

## Sessions cannot reach GitHub behind a company proxy

The doctor's "Network for sessions" line says what stands between your sessions and `github.com` and `api.githubcopilot.com`:

- **The proxy is not used**: set `HTTPS_PROXY` (and `HTTP_PROXY`) to it, and `NO_PROXY` to the hosts that bypass it.
- **The proxy wants a login (407)**: put the login into the address, `http://user:password@host:port`.
- **A certificate Copilot CLI does not trust**: your company's proxy replaces certificates, and Copilot CLI runs on Node.js, which reads only its own list. Set `NODE_EXTRA_CA_CERTS` to the proxy's root certificate as a PEM file; when this computer already trusts that certificate, the doctor names the file to use. `NODE_USE_SYSTEM_CA=1` makes Node.js 22.15 or newer use the system's certificates instead.
- **The host cannot be found or reached**: check the VPN, or ask whoever runs the proxy to allow the host.

Set these where Trackwall sees them, as [Environment variables](/guide/environment-variables) shows (a user variable on Windows, `launchctl setenv` on macOS, `containerEnv` in a dev container), then "Quit" from the tray, start Trackwall again and click "Check again".

## Git cannot reach a repo host

The doctor's "Git access to repo hosts" line names the host and why: no SSH key, an unknown host key, or no sign-in for HTTPS. Trackwall's git cannot ask for a password, so set up what your terminal uses without one, such as an SSH key in the agent or a credential manager, and check that `git fetch` in that repo works without a question. Your own ssh program goes in `GIT_SSH_COMMAND`. In a dev container, see [Git and SSH](/guide/dev-container#git-and-ssh). For searching and cloning in "Repos", `gh` or `glab` must be signed in, which the doctor checks too.

## mise tasks or services do not start

Install [mise](https://mise.jdx.dev/getting-started.html) and restart Trackwall. A repo's tasks run only after you trust its mise configuration: the "mise tasks" tab offers a button for it, or run `mise trust` in the repo. A service needs a `dev` task; see [mise tasks](/features/mise-tasks) and [Services](/features/services).

## Tasks refuse to start because of the sandbox

The doctor's "Copilot CLI sandbox for tasks" line says why Copilot CLI's sandbox cannot run here. Either give the computer or container what it lacks (on Linux the `bubblewrap` package; see [Copilot CLI's sandbox](/guide/dev-container#copilot-cli-s-sandbox) for a dev container), or choose "No task" in "Settings > Agents > Sandbox".

## Trackwall is slow

- The doctor's "Antivirus scanning" line names the folders an antivirus slows down; have them left out of real-time scanning.
- Lines starting with `[git]` in `logs/daemon-start.log` list every git call that took 5 seconds or more.
- Repos in a folder mounted into a container or WSL are slow; keep them in a Docker volume ([Run in a dev container](/guide/dev-container)).

## An approval has no buttons

A session shows "Needs you: approval", but Trackwall shows no buttons: it could not read the question from the terminal, usually after a Copilot CLI update changed its screen. Answer in the terminal, and update Trackwall when it offers a new version. The doctor's "Copilot CLI" line warns when your Copilot CLI is older than the version Trackwall is tested with. See [Approvals](/features/approvals).

## The update does not download

A proxy that signs you in with your Windows account or replaces certificates can stop the download. Update by hand as [Install](/guide/install#update) shows; your data in `~/.trackwall` stays.

## Where to look next

- "Settings > Diagnostics" has the doctor and [Trackwall errors](/features/trackwall-errors), Trackwall's own errors without your names and paths, ready to read before you share them.
- `logs/daemon-start.log` in the state folder has the daemon's last start; in a dev container its output is in `~/.trackwall/logs/daemon.log`.
- [Limits today](/guide/limits) lists what Trackwall does not do yet, so you can tell a missing feature from a bug.
