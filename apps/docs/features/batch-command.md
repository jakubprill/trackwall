---
title: Batch command
description: Sync, install, set up and build many repos with one command, and see the result for each one.
---

# Batch command

Sync, install, set up and build many repos with one command, and see the result for each one.

## What you get

- One panel to bring many repos to a working state: sync, tools, dependencies and build.
- Three repos at a time, with every step's result in every repo.
- The exit code and last lines of output wherever something failed.
- A "Cancel" that stops what is running and starts nothing more.

## How it works

"Batch command", under the repo list, opens a panel. Choose the repos (by default every repo the tag filter shows) and the steps: sync, tools (`mise install`), dependencies (the mise task `setup`) and build (the mise task `build`).

Each repo runs its steps in order, and three repos run at once. The panel fills in as the steps finish. A repo without one of the mise tasks skips that step; an error stops only that repo, and the others carry on.

"Cancel" stops the mise tasks that are running, including one you had started yourself from the repo before the command took it over, and starts no further ones.

## Use it

1. In "Repos", narrow the list with the tag filter if you like.
2. Press "Batch command".
3. Choose the repos and steps, and start.
4. Read the result per repo and step; a failed step shows why it failed, and its last lines, under the repo.

## Good to know

- A repo tagged `no-mise` has no mise tasks for the setup and build steps.
- Running the command again is fast when the mise tasks declare their `sources` and `outputs` in `mise.toml`, because mise then skips work that is up to date.
