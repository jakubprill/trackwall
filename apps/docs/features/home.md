# Home dashboard

See the whole environment in one 3D frame and what needs you right now.

The "Home" view (Ctrl+1) opens after startup and shows the environment in one 3D frame (ADR-33): the daemon in the middle, Copilot CLI sessions on the inner track next to their repo, repos on the outer ring in the arcs of the layers (entries, gateways, backends, libraries, like the columns in "Overview") and the connections from the graph. Only what needs attention has a label: a repo with changes, with commits to pull or unavailable, and a session that is waiting for you or has an error; colour and shape say the rest, and hovering with the cursor shows the name and state in the corner.

A session whose ended turn you have already seen is idle: calm grey, without a label and outside "Needs you" (ADR-47). The "Needs you" queue on the left lists the same sessions and repos (and, between them, task proposals waiting for a decision; a click opens the proposal in "Sessions"), and the panel on the right the details of the selected object (state, branch, running mise task, the repo's sessions). A session in the queue has the window title next to the repo, so that two sessions of one repo can be told apart.

A click selects an object and points the camera at it, a double click or "Open repo" / "Open session" / "Open Daemon" (after selecting the core in the middle) goes to its view; without a selection the panel on the right summarises the environment. Without WebGL (an old driver, a blocked graphics card) or after the graphics context is lost, in place of the scene there is a message with a "Try again" button, and the queue and the details keep working. When the projects folder has disappeared or `workspace.yaml` has an error, the view shows the error and "Open Settings" instead of the old list. With reduced motion turned on in the system the models stand still.

## Decisions

Why it works this way: [ADR-33](https://github.com/jakubprill/trackwall/blob/main/docs/architecture.md#12-decisions-adrs-in-brief), [ADR-47](https://github.com/jakubprill/trackwall/blob/main/docs/architecture.md#12-decisions-adrs-in-brief) in the architecture document.
