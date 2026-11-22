---
title: Container health
description: See how your dev container's memory, processors and disk are doing, and why a build died without a reason.
status: preview
---

# Container health

See how your dev container's memory, processors and disk are doing, and why a build died without a reason.

::: warning Preview
The panel is new, so what it measures and when it warns can still change.
:::

## What you get

- Memory, processors, processes and free disk against the limits of the container, at a glance.
- A process the kernel killed for lack of memory, or a crash and restart of Trackwall's daemon, shows up with when, instead of a build that just stopped.
- The day's memory as a chart, so you see when it filled up.
- A warning when something lasts: memory nearly full, processors held back, a low disk, or work on no remote with no fresh [backup](/features/work-backup), also on [Home](/features/home), whose icon counts them in every view.
- Agents check it themselves when a build dies without a reason, instead of hunting for a bug that is not there.

## How it works

In a [dev container](/guide/dev-container), builds, tests and agents share the memory and processors Docker gives the container, and the disk of Docker's virtual machine. When memory runs out, the kernel kills a process, often a build's Java, and the build's own log says nothing about why. Settings › Diagnostics › Container health shows what the container counts for itself.

Each tile shows one resource: how much is in use, the container's limit, and a bar. Without a limit of its own, a tile names what the machine Docker runs on has, which the container shares. Trackwall reads the counts every 30 seconds and keeps a day of them, so the chart and the list under "Today" still show the morning after Trackwall restarts.

Above the tiles, warnings name what needs you and what to do. A short peak does not raise one: memory has to stay above 90% of the limit for five minutes, and the processors held back for more than a fifth of the time for ten. A kill for memory or a crash of the daemon warns for an hour. The "Settings" icon on the view bar shows how many there are, whichever view you are in, and Settings then opens here, on "Diagnostics". The same warnings stand under "Container" in "Needs you" on [Home](/features/home), and a click there brings you here.

Agents read the same state with the `get_container_health` tool of the [MCP server](/features/mcp). When a build or a test of theirs ends with exit code 137 or a Java process vanishes, they check it first, and a kill for memory near that time tells them the fix is more memory, not a change to the code.

## Use it

1. Run Trackwall in a [dev container](/guide/dev-container).
2. Open Settings › Diagnostics › Container health.
3. When a build or a test ends without a reason, look under "Today" for a process killed for memory, and give the container more memory or run fewer builds at once.

## Tools

| Tool | What it gives the agent |
|---|---|
| `get_container_health` | Memory, processors, processes and disk against the container's limits, processes killed for memory and daemon restarts in the last day, and the warnings. |

## Good to know

- Only in a dev container. On your own computer the panel says there is nothing to show.
- Memory, processors and processes need cgroup v2, which current Docker, Rancher Desktop and Colima use. Without it the panel shows only the disk and the daemon's restarts.
- The disk is the disk of Docker's virtual machine, shared with other containers and images; `docker system prune` frees space on it.
- The readings stay in the container, in `container-health` of Trackwall's state folder, a day at a time.
