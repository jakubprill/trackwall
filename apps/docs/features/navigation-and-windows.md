# Navigation and windows

Move between views with the bar on the left and spread views over several windows and monitors.

Views are switched by the bar at the left edge of the window, as in VS Code: Home (Ctrl+1), Repos (Ctrl+2), Sessions (Ctrl+3) and Overview (Ctrl+4) at the top, Daemon (Ctrl+9) and Settings (Ctrl+,) at the bottom; on macOS ⌘ instead of Ctrl. A tooltip on hovering over the icon shows the view's name and shortcut.

## Several windows

A view can open in a new window, for example the session grid on one monitor and Home or Repos on another. Right-click a view icon and choose "Open in new window", press Ctrl+Shift + the view's digit (Ctrl+Shift+3 opens Sessions; on macOS ⌥⌘3, because ⌘⇧3 takes a screenshot), press Ctrl+Shift+N (⌘⇧N) for the current view (Settings opens in a new window only this way or from the menu), or choose "New window" in the tray. Every window has the view bar, switches views on its own (Ctrl + digit and Alt + digit work in the window you are in) and shows the same sessions and repos live.

A window opens on the monitor, at the size and position where the window in its place was last time; if that monitor is unplugged, it opens at the default position. When you start Trackwall again, the extra windows that were open when you quit come back on their monitors with the same view and session layout; a window you closed yourself does not. Closing an extra window closes it, while the main window still hides to the tray. "Waiting: &lt;repo&gt;" in the tray opens the session in the window that shows Sessions, so the window on the other monitor keeps its view.

With the same session open in two windows, the window you work in sets the terminal size. Each window's title names its view ("Sessions – Trackwall"), so windows differ in the taskbar. On macOS the menu bar has the views in View (⌘1…⌘4, ⌘9), Settings… (⌘,) in the Trackwall menu, and Window with New Window (⌘⇧N, the current view of the window you are in) and the list of open windows.

## Decisions

Why it works this way: ADR-49 in [§12 of the architecture document](https://github.com/jakubprill/trackwall/blob/main/docs/architecture.md#12-decisions-adrs-in-brief).
