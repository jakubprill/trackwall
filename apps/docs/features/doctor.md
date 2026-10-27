---
title: Doctor
description: The doctor in Settings checks what Trackwall needs on your computer and says what to do about anything missing.
---

# Doctor

The doctor in Settings checks what Trackwall needs on your computer and says what to do about anything missing.

## What you get

- One list of what Trackwall relies on: your projects folder, Git, Copilot CLI, mise, and gh or glab for your repo hosts.
- For each problem, the step that fixes it, such as the folder to add to Copilot CLI's trusted folders or the login command.
- A warning when your Copilot CLI is older than the version Trackwall is tested with.
- A fresh check whenever you open Settings or click "Check again".

## How it works

When you open "Settings", the "Doctor" section runs its checks, which takes a few seconds. Each line shows what was checked, its state ("OK", "Check" or "Problem"), what was found, and what to do when it is not OK. The line above the list says whether everything is in place or how many checks need your attention.

The checks are:

| Check | OK when |
| --- | --- |
| Projects folder | it is set and exists |
| Git | `git --version` answers |
| Copilot CLI | Trackwall finds it the way it starts sessions, and it is not older than the version Trackwall is tested with |
| Copilot CLI trusted folder | `trustedFolders` in Copilot CLI's `config.json` covers your projects folder, so Copilot CLI does not ask before working in each repo and task |
| mise | `mise --version` answers; repo tasks, services and task verification need it |
| GitHub CLI (gh), GitLab CLI (glab) | it is signed in to every repo host of that kind in "Repo hosts"; shown only when you have such a host |

The doctor only looks. It never changes a setting, installs anything or signs you in, and its results are not saved or sent anywhere.

## Use it

1. Open "Settings" (Ctrl+, or ⌘, on macOS) and scroll to "Doctor".
2. Do what a line that is not "OK" says, for example run `gh auth login --hostname github.com` in a terminal.
3. Click "Check again" to see the result.

## Good to know

- After installing a program, restart Trackwall if the doctor still does not find it.
- A check of gh or glab asks the repo host, so without a network or VPN it shows as not signed in.
- Whether Copilot CLI itself is signed in is not checked; a session that cannot sign in says so in its terminal.
- Errors of Trackwall itself are listed under [Trackwall errors](/features/trackwall-errors).
