---
title: Home dashboard
description: See your whole environment in one 3D view, with everything that needs you in one queue.
---

# Home dashboard

See your whole environment in one 3D view, with everything that needs you in one queue.

## What you get

- Trackwall, your sessions and your repos in one living picture.
- Labels only on what needs attention: a repo with changes, commits to pull or a problem, a session waiting for you or with an error.
- A "Needs you" queue with every waiting session, repo and task proposal.
- One click from anything in the picture to its view.

## How it works

"Home" opens when Trackwall starts. Trackwall sits in the middle, sessions circle it on the inner track next to their repo, and repos sit on the outer ring, grouped into arcs by layer (entries, gateways, backends, libraries, as in the [connection graph](/features/graph)), with the graph's connections between them. Colour and shape show the state; hover over anything to see its name and state in the corner.

The "Needs you" queue on the left lists what waits for you: sessions, repos and [task proposals](/features/main-session). A session shows its window title next to the repo, so two sessions of one repo can be told apart. A session whose finished turn you have already seen turns calm grey and leaves the queue.

Click an object to select it and turn the camera to it; the panel on the right shows its details: state, branch, running mise task, the repo's sessions. Double-click, or use "Open repo", "Open session" or "Open Daemon", to go to its view. With nothing selected, the panel summarises the whole environment.

## Use it

1. Start Trackwall, or press Ctrl+1 (⌘1 on macOS).
2. Work through the "Needs you" queue from the top.
3. Click anything in the picture for its details; double-click to open it.

## Good to know

- Without WebGL (an old graphics driver, a blocked graphics card), or when the graphics card drops the picture, a message with "Try again" takes the place of the picture; the queue and the details keep working.
- When the projects folder has gone or `workspace.yaml` has an error, the view says so and offers "Open Settings".
- With reduced motion turned on in your system, the picture stands still.
