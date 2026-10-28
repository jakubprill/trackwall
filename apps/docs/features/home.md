---
title: Home dashboard
description: See your whole environment in one 3D view, with everything that needs you in one queue.
---

# Home dashboard

See your whole environment in one 3D view, with everything that needs you in one queue.

![Home: the 3D dashboard of twenty repos and their connections, with the sessions waiting for you on the left](/screenshots/home.png)

## What you get

- Trackwall, your sessions and your repos in one living picture.
- A label beside every repo, with what is going on in it (changes, commits to pull, a problem or a running task), and on every session waiting for you or with an error.
- Two looks to choose from: holograms, or lighter glowing orbs for a slow graphics card.
- A "Needs you" queue with every waiting session, repo and task proposal.
- One click from anything in the picture to its view.

## How it works

"Home" opens when Trackwall starts. Trackwall sits in the middle, sessions circle it on the inner track next to their repo, and repos sit on the outer ring, grouped into arcs by layer (entries, gateways, backends, libraries, as in the [connection graph](/features/graph)), with the graph's connections between them. Colour and shape show the state: a ring around each repo fills as its changes or commits to pull pile up, and the floor around Trackwall shows how many sessions are working and how many wait for you. Each repo has a label beside it, joined by a thin line: the name, and when something is going on, what it is, in the state's colour. Labels that would cover each other move apart. Hover over anything to see its name and state in the corner. Repos appear at once, faint and without a label of their own until git has read them.

The "Needs you" queue on the left lists what waits for you: sessions, repos and [task proposals](/features/main-session). A session shows its window title next to the repo, so two sessions of one repo can be told apart. A session whose finished turn you have already seen turns calm grey and leaves the queue.

Click an object to select it and turn the camera to it; the panel on the right shows its details: state, branch, running mise task, the repo's sessions. A session asking for approval shows the request there too, and you can [answer it](/features/approvals) without leaving Home. Double-click, or use "Open repo", "Open session" or "Open Diagnostics", to go to its view; "Open Diagnostics" opens "Settings > Diagnostics". With nothing selected, the panel summarises the whole environment.

## Use it

1. Start Trackwall, or press Ctrl+1 (⌘1 on macOS).
2. Work through the "Needs you" queue from the top.
3. Click anything in the picture for its details; double-click to open it.

## Good to know

- Without WebGL (an old graphics driver, a blocked graphics card), or when the graphics card drops the picture, a message with "Try again" takes the place of the picture; the queue and the details keep working. The same message shows when the 3D view fails for any other reason, and a view that fails shows its error with "Try again" while the bar on the left and the other views keep working.
- When the projects folder has gone or `workspace.yaml` has an error, the view says so and offers "Open Settings".
- With reduced motion turned on in your system, the picture stands still.
- When you are not touching the picture, it moves more slowly, so that it does not slow down your sessions and the rest of the computer; it is smooth again as soon as you point at it.
- "Settings > App > Home scene" sets how the picture looks on this computer: "Holograms" (each kind of repo in its own shape) or "Orbs" (glowing spheres, lighter for a slow graphics card), and labels on "Every repo" or "Only what needs you" (the repos and sessions of the "Needs you" queue). Home uses the change the next time you open it.
