# Trackwall for VS Code

See your Trackwall sessions while you read other code: what waits for you in the status bar, and every session in the "Trackwall" side bar. Click a session to open it in Trackwall.

The extension only reads. It cannot start, stop or answer a session, and it talks only to Trackwall on this computer.

## Turn it on

1. In Trackwall, open "Settings", choose "App" and tick "Let the VS Code extension see the sessions" under "VS Code extension".
2. In VS Code, run "Extensions: Install from VSIX…" and pick `trackwall-<version>.vsix`.

The status bar shows how many sessions and task proposals wait for you, or how many sessions run. The "Trackwall" side bar groups the sessions into "Waiting for you", "Running" and "Ended".

## Good to know

- In a dev container, install the extension in the container's VS Code window, where Trackwall runs.
- When Trackwall keeps its state somewhere else than `.trackwall` in your home folder, set "Trackwall: State Folder" in VS Code's settings, or `TRACKWALL_HOME`.

More: [the documentation](https://jakubprill.github.io/trackwall/features/vscode-extension).
