---
title: Notifications in the browser
description: See in the tab's title how many agents wait for you, and get a browser notification when one needs you while you work elsewhere.
---

# Notifications in the browser

See in the tab's title how many agents wait for you, and get a browser notification when one needs you while you work elsewhere.

## What you get

- The number of sessions and task proposals waiting for you in front of the tab's title, as in "(2) Trackwall".
- A notification from the browser when a session asks for approval, waits for its plan to be approved or finishes its turn.
- One notification for a plan of task proposals, which grows as the agent proposes more.
- A click on the notification brings the tab forward and opens that session or proposal in "Sessions".

## How it works

This is for Trackwall opened in a browser tab, for example when it runs [in a dev container](/guide/dev-container) and you open it at `http://127.0.0.1:7700`. The desktop app does the same with system notifications, a tray and a badge on its icon, as described in [Copilot CLI sessions](/features/sessions).

The tab's title always shows how many sessions wait for you and how many task proposals wait for your decision, the supervisor included. You see it on the tab itself, also with many tabs open, without notifications turned on.

The first time you open Trackwall in a browser, a strip above the views offers "Turn on notifications". After you click it, the browser asks whether the page may show notifications. From then on, when a session that was working starts waiting for you while you are in another tab or another app, the browser shows a notification such as "Session in orders-api: Copilot CLI is asking for approval". When you look at the Trackwall tab, nothing pops up: the tab already shows it.

## Use it

1. Open Trackwall in your browser.
2. Click "Turn on notifications" in the strip above the views, or in "Settings > App" under "Notifications in the browser".
3. Choose "Allow" when the browser asks.
4. Switch to another window: the next session that needs you shows a notification.

## Good to know

- Trackwall shows notifications only while its tab is open. Close the tab and nothing reaches you; a tab in the background or in a minimized window is enough.
- "Not now" hides the strip in this browser. You can still turn notifications on in "Settings > App".
- To turn notifications off, or on again after choosing "Block", change the notification permission for the page in your browser's site settings, then reload the tab.
- A session or proposal that was already waiting when you opened the tab does not show a notification; the title counts it.
- With two Trackwall tabs open, each wait shows one notification, not two.
- Your system decides how notifications look and whether they make a sound. When "Do not disturb" or "Focus" is on, they go straight to the notification centre.
