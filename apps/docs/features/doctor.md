---
title: Doctor
description: The doctor in Settings checks what Trackwall needs on your computer and says what to do about anything missing.
---

# Doctor

The doctor in Settings checks what Trackwall needs on your computer and says what to do about anything missing.

## What you get

- One list of what Trackwall relies on: your projects folder, your workspace settings file, Git, Copilot CLI, the network your sessions use, the model provider of your session profile, mise, Java navigation once you set it up, and gh or glab for your repo hosts.
- For each problem, the step that fixes it, such as the folder to add to Copilot CLI's trusted folders or the login command.
- Behind a company proxy, the exact problem between your sessions and GitHub: a proxy that wants a login, or a company certificate Copilot CLI does not trust, with the value that fixes it.
- A warning when your Copilot CLI is older than the version Trackwall is tested with.
- A fresh check whenever you open "Settings > Diagnostics" or click "Check again".

## How it works

When you open "Settings > Diagnostics", the "Doctor" section at the top runs its checks, which takes a few seconds. Each line shows what was checked, its state ("OK", "Check" or "Problem"), what was found, and what to do when it is not OK. The line above the list says whether everything is in place or how many checks need your attention.

The checks are:

| Check | OK when |
| --- | --- |
| Projects folder | it is set and exists |
| Projects folder storage | your projects folder is in the Linux file system; the line shows only on Linux, as a warning when the folder is a folder of your computer mounted into a container or WSL (such as `/mnt/c/...` or a Docker bind mount), where git and builds are slow; see [Run in a dev container](/guide/dev-container) |
| Work only in this container | every commit, stash and changed file in your repos and task worktrees is pushed; the line shows only when Trackwall runs in a container, as a warning with how much is only there, since removing the container's volume deletes it; [Home](/features/home) lists the repos |
| Workspace settings file | every key of `workspace.yaml` can be read; one that cannot is named with its line, and [Config files](/features/config-files) shows them all |
| Git | `git --version` answers; with a "Git program" chosen in Settings the line names the git it runs, and it warns when the "Git program" from Settings did not answer and git from `PATH` is used instead |
| Copilot CLI | Trackwall finds it the way it starts sessions, and it is not older than the version Trackwall is tested with |
| Copilot CLI trusted folder | `trustedFolders` in Copilot CLI's `config.json` covers your projects folder, so Copilot CLI does not ask before working in each repo and task |
| Network for sessions | `github.com` and `api.githubcopilot.com` answer through the proxy your sessions use (`HTTPS_PROXY`, `NO_PROXY`) with a certificate Copilot CLI trusts (its own list plus `NODE_EXTRA_CA_CERTS`); when your company's proxy replaces certificates and this computer already trusts its certificate, the line names the file to put in `NODE_EXTRA_CA_CERTS` |
| Model provider of the session profile | something accepts connections at the address in `COPILOT_PROVIDER_BASE_URL`, for example your local proxy in front of another model; shown only when a [session profile](/features/mise-environment) is set and its mise environment in your projects folder sets that address |
| mise | `mise --version` answers; repo tasks, services and task verification need it |
| Java navigation | tasks can start the Java language server with the paths in your settings; shown only once you set up [Java navigation](/features/java-navigation) |
| GitHub CLI (gh), GitLab CLI (glab) | it is signed in to every repo host of that kind in "Repo hosts"; shown only when you have such a host |

The doctor only looks. It never changes a setting, installs anything or signs you in, and its results are not saved or sent anywhere. The network check only opens a connection to GitHub and Copilot and closes it, without sending anything but the proxy's login when its address has one; a proxy is shown only as its host and port, never with the password its address may carry. The model provider check only opens a connection to the provider's host and closes it: it sends nothing to the provider, never reads your API key, and never shows the provider's address, which may carry a key.

## Use it

1. Open "Settings" (Ctrl+, or ⌘, on macOS) and choose "Diagnostics"; "Doctor" is at the top.
2. Do what a line that is not "OK" says, for example run `gh auth login --hostname github.com` in a terminal.
3. Click "Check again" to see the result.

## Good to know

- After installing a program, restart Trackwall if the doctor still does not find it.
- A check of gh or glab asks the repo host, so without a network or VPN it shows as not signed in.
- Sessions start with the environment Trackwall started with, so after changing `HTTPS_PROXY` or `NODE_EXTRA_CA_CERTS` restart Trackwall and click "Check again". In a dev container, set them in `containerEnv`; see [Run in a dev container](/guide/dev-container).
- Your own MCP servers and the certificates of Java builds are not checked.
- The model provider check tells whether something answers at the provider's address, not whether your key or model name is right; a session started with the profile shows that in its terminal.
- Whether Copilot CLI itself is signed in is not checked; a session that cannot sign in says so in its terminal.
- Errors of Trackwall itself are listed under [Trackwall errors](/features/trackwall-errors).
