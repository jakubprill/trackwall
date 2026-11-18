---
title: Get started
description: One list in Settings shows what is left before your first session and says when Trackwall is ready.
---

# Get started

One list in Settings shows what is left before your first session and says when Trackwall is ready.

## What you get

- The few things Trackwall needs, in the order to do them: your projects folder, Git, Copilot CLI and the network your sessions use.
- For each one, what Trackwall found on your computer and what to do when something is missing.
- Two steps settled with one click right in the list: your projects folder, when Trackwall finds a likely one, and "Trust folder", which stops Copilot CLI asking whether it may work in each repo and task.
- A clear "Ready" with a "Start a session" button once nothing needed is left.
- The same list whether Trackwall runs on your computer or in a container; it says which.

## How it works

Trackwall needs only one setting to work: your projects folder. Everything else in Settings has a default that works. What else can stop a first session is outside Settings: Copilot CLI is not installed, or a company proxy stands between your sessions and GitHub.

"Get started" is the first category of Settings, in a frame of its own above the others. Settings opens on it until you have a session, and also later while a step is still open. It runs the [doctor](/features/doctor) and shows a few of its checks as steps. A step with a green mark is done. A step with a number has something for you to do: the line under it says what was found, the next one what to do, and a command to run comes with a copy button. A step marked "needed" stops a first session; one marked "recommended" does not, but saves you questions later, such as Copilot CLI asking whether it may trust each repo.

The step "Copilot CLI trusts your projects folder" has a "Trust folder" button. Copilot CLI keeps a list of folders it works in without asking, `trustedFolders` in its `config.json`. The button adds your projects folder to that list, which covers every repo in it and their task worktrees. Trackwall leaves the rest of the file as it is and keeps a copy of the file as it was next to it, named `config.before-trackwall-trust.json`. The line under the button names the file, if you would rather edit it yourself.

Under the steps, "Good to have" lists tools Trackwall works without and what each adds: mise for repo tasks and services, Copilot CLI's sandbox, and the command-line tool of your repo host. Click it to open the list.

The line under "Get started" in the list of categories says what is left: how many steps are to do, in yellow, or "All set". It shows what the last check found, so it is there as soon as Settings opens, and it updates when you open "Get started" or "Diagnostics", which run the check again.

## Use it

1. Start Trackwall. On Home, click "Get started", or open "Settings" (Ctrl+, or ⌘, on macOS).
2. In "Projects folder", click "Use this folder" when Trackwall found yours, or type its path and click "Save".
3. Do what each numbered step says, from the top. In "Copilot CLI trusts your projects folder", click "Trust folder".
4. Click "Check again" after installing a program or changing the network settings.
5. When the list says "Ready", click "Start a session".

## Good to know

- After installing a program, restart Trackwall if "Check again" still does not find it.
- Sessions start with the environment Trackwall started with, so after changing a proxy or certificate setting restart Trackwall too.
- Whether Copilot CLI is signed in is not checked; a session that cannot sign in says so in its terminal.
- The list only looks, like the doctor. It changes two things, each only when you click: your projects folder, when you save it, and Copilot CLI's list of trusted folders, with "Trust folder".
- "Trust folder" covers every repo in your projects folder, also one you clone later. Copilot CLI then reads such a repo's own instructions and settings without asking first, so keep repos you do not trust outside your projects folder.
- Sessions that are already running keep asking; one you start after the click does not.
- When Copilot CLI's `config.json` cannot be read as its own, "Trust folder" leaves it alone and says why.
- "Settings > Diagnostics" shows every check of the doctor, also those that do not stop a session, such as free disk space.
- [Troubleshooting](/guide/troubleshooting) explains each step that does not turn green: installing and signing in to Copilot CLI, trusting your projects folder, and a company proxy.
- In a container, Trackwall has to be running before the list can help; [Run in a dev container](/guide/dev-container) describes that part.
