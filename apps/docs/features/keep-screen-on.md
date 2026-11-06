---
title: Keep the screen on
description: Keep the screen from turning off and locking while agents work, so you can glance at them without signing in again.
---

# Keep the screen on

Keep the screen from turning off and locking while agents work, so you can glance at them without signing in again.

## What you get

- The screen stays on while a session or an agent task is in the middle of its turn, and turns off as usual once they are done.
- No more signing in again just to see whether an agent is waiting for you.
- A choice of off, only while agents work, or always while Trackwall runs. It is off until you choose.

## How it works

Choose how long the screen stays on under "Keep the screen on" in "Settings > App". Trackwall then asks the system to keep the display on, the same way a video player or a presentation does. It does not move the mouse or press keys.

With "While agents work", the screen stays on as long as at least one session or agent task is working on its turn, the supervisor included. When every agent has finished or waits for you, Trackwall stops asking, and the system's own power settings turn the screen off and lock it after their usual time. A session that may be stuck does not keep the screen on.

With "Always, while Trackwall runs", the screen stays on until you quit Trackwall. Closing the window to the tray does not end it; quitting does.

## Use it

1. Open "Settings" (Ctrl+, or ⌘, on macOS).
2. Choose "App", and under "Keep the screen on" pick "While agents work".
3. Start a task and leave the computer alone: the screen stays on until the agent finishes its turn.

## Good to know

- A lock or screen saver your organisation enforces after a time without input can still lock the screen: such a policy may count the time from your last key press or mouse move, whatever an app asks for. Trackwall does not try to get around it.
- Only the desktop app keeps the screen on; Trackwall in a browser tab does not.
- On Windows, `powercfg /requests` (in a terminal run as administrator) lists Trackwall under "DISPLAY" while it keeps the screen on. On macOS, `pmset -g assertions` lists it.
- Locking the screen yourself (Windows+L, or Ctrl+⌘+Q on macOS) works as always.
- On a laptop on battery the screen stays on too, so it uses more power while agents work.
