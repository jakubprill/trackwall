---
title: Get started
description: One list in Settings shows what is left before your first session and says when Trackwall is ready.
---

# Get started

One list in Settings shows what is left before your first session and says when Trackwall is ready.

## What you get

- The few things Trackwall needs, in the order to do them: your projects folder, Git, Copilot CLI and the network your sessions use.
- For each one, what Trackwall found on your computer and what to do when something is missing.
- Your projects folder set right in the list, with one click when Trackwall finds a likely folder.
- A clear "Ready" with a "Start a session" button once nothing needed is left.
- The same list whether Trackwall runs on your computer or in a container; it says which.

## How it works

Trackwall needs only one setting to work: your projects folder. Everything else in Settings has a default that works. What else can stop a first session is outside Settings: Copilot CLI is not installed, or a company proxy stands between your sessions and GitHub.

"Get started" is the first category of Settings, and Settings opens on it until you have a session. It runs the [doctor](/features/doctor) and shows a few of its checks as steps. A step with a green mark is done. A step with a number has something for you to do: the line under it says what was found, the next one what to do, and a command to run comes with a copy button. A step marked "needed" stops a first session; one marked "recommended" does not, but saves you questions later, such as Copilot CLI asking whether it may trust each repo.

Under the steps, "Good to have" lists tools Trackwall works without and what each adds: mise for repo tasks and services, Copilot CLI's sandbox, and the command-line tool of your repo host. Click it to open the list.

The number next to "Get started" in the list of categories says how many steps are still open.

## Use it

1. Start Trackwall. On Home, click "Get started", or open "Settings" (Ctrl+, or ⌘, on macOS).
2. In "Projects folder", click "Use this folder" when Trackwall found yours, or type its path and click "Save".
3. Do what each numbered step says, from the top.
4. Click "Check again" after installing a program or changing the network settings.
5. When the list says "Ready", click "Start a session".

## Good to know

- After installing a program, restart Trackwall if "Check again" still does not find it.
- Sessions start with the environment Trackwall started with, so after changing a proxy or certificate setting restart Trackwall too.
- Whether Copilot CLI is signed in is not checked; a session that cannot sign in says so in its terminal.
- The list only looks, like the doctor. The one thing it changes is your projects folder, when you save it.
- "Settings > Diagnostics" shows every check of the doctor, also those that do not stop a session, such as free disk space.
- [Troubleshooting](/guide/troubleshooting) explains each step that does not turn green: installing and signing in to Copilot CLI, trusting your projects folder, and a company proxy.
- In a container, Trackwall has to be running before the list can help; [Run in a dev container](/guide/dev-container) describes that part.
