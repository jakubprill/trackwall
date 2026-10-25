---
title: Navigation and windows
description: Move between views with the keyboard, and spread Trackwall over several windows and monitors.
---

# Navigation and windows

Move between views with the keyboard, and spread Trackwall over several windows and monitors.

![Two Trackwall windows side by side, put together from two screenshots: sessions in one, the connection graph in the other](/screenshots/windows.png)

## What you get

- Every view one key away.
- Any view in its own window, for example the session grid on one monitor and "Repos" on another.
- Windows that come back where you left them when Trackwall starts again.
- Each window at its own zoom: larger text on a laptop, more on screen on an ultrawide.

## How it works

The bar at the left edge of the window switches views, as in VS Code: "Home", "Repos", "Sessions" and "Overview" at the top, "Daemon" and "Settings" at the bottom. Hover over an icon to see the view's name and key.

Any view can open in a new window: right-click its icon and choose "Open in new window", press Ctrl+Shift with the view's digit, or choose "New window" in the tray. Every window has its own view bar, switches views on its own and shows the same sessions and repos live. Each window's title names its view ("Sessions – Trackwall"), so you can tell them apart in the taskbar.

Ctrl+= and Ctrl+- make everything in a window larger or smaller, from half to double size, and Ctrl+0 brings it back to normal. Each window keeps its own zoom, also after Trackwall starts again.

A window opens on the monitor, at the size and position its predecessor had. When you start Trackwall again, the extra windows that were open when you quit come back on their monitors with the same view and session layout. A window you closed yourself stays closed.

## Use it

1. Press Ctrl+1 … Ctrl+4 to switch views (⌘ on macOS).
2. Press Ctrl+Shift+3 to open "Sessions" in a new window, and drag it to your other monitor.

## Shortcuts

| Keys (Windows) | Keys (macOS) | What happens |
|---|---|---|
| Ctrl+1, Ctrl+2, Ctrl+3, Ctrl+4 | ⌘1, ⌘2, ⌘3, ⌘4 | Home, Repos, Sessions, Overview. |
| Ctrl+9 | ⌘9 | Daemon. |
| Ctrl+, | ⌘, | Settings. |
| Ctrl+Shift+digit | ⌥⌘digit | Open that view in a new window. |
| Ctrl+Shift+N | ⌘⇧N | Open the current view in a new window. |
| Ctrl+= or Ctrl++, Ctrl+- | ⌘=, ⌘- | Zoom this window in or out. |
| Ctrl+0 | ⌘0 | Back to actual size. |

## Good to know

- On macOS the new-window keys use ⌥⌘, because ⌘⇧3 takes a screenshot.
- Settings opens in a new window only with Ctrl+Shift+N or from the menu.
- Closing an extra window closes it; the main window hides to the tray.
- "Waiting: orders-api" in the tray opens the session in the window that shows "Sessions", so your other windows keep their view.
- With the same session open in two windows, the window you type in sets the terminal size.
- If a window's monitor is unplugged, the window opens at the default position.
- The tray panel keeps its size; zoom changes only Trackwall's windows.
- The zoom keys belong to the window, so they do not reach a session's terminal.
- A new window that takes the place of a closed one starts at the closed window's zoom, as it does at its position.
- On macOS the menu bar has the views and the zoom under View, Settings… under Trackwall, and New Window and the list of open windows under Window.
