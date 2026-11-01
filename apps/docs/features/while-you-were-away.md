---
title: While you were away
description: Come back from a meeting to one line that says which agents finished, which wait for you and which may be stuck, each a click away.
---

# While you were away

Come back from a meeting to one line that says which agents finished, which wait for you and which may be stuck, each a click away.

## What you get

- One strip above the views when you come back, such as "While you were away (1 h 20 min): 4 changes, 3 need you".
- The list of what changed: proposals that came, sessions that ask for approval or wait for you, tasks that reported a result, sessions that ended or failed.
- A "may be stuck" warning on a session that has been busy for a long time without doing anything, here and in "Sessions".
- A click on an item opens that session, task or proposal.

## How it works

Trackwall notices when you have not touched any of its windows for 15 minutes: no key, click, scroll or mouse move, and none brought to the front. The first time you do one of those again, it compares the sessions with the moment you left. If something changed, a strip appears above the views with how long you were away and how much changed. Press "Show" to see the list: what needs you first, then the newest.

The list shows the work as it is now, not every step on the way. A task that finished its turn while you were away and now asks for approval is one item that says "asking for approval", and the first line of the result it reported. A session that was already waiting before you left is not news, and neither is a session you stopped yourself.

A session may be stuck when it is in the middle of a turn and its agent has taken no step for 15 minutes: no tool finished, no new message, no key from you. That is what a command that never ends looks like, such as a server started in the foreground or a script waiting for input, even while Copilot CLI keeps its spinner going. The session then shows "may be stuck" in "Sessions" instead of "working", and in the strip with how long it has been quiet. It is a hint, not a verdict: look at its terminal, and press Esc to interrupt the agent if it is really stuck. The next step of the agent clears it.

## Use it

1. Leave Trackwall alone for at least 15 minutes while your agents work.
2. Come back and move the mouse over a Trackwall window.
3. Press "Show" in the strip, and click an item to open it.
4. Press "Dismiss" when you are done; the strip goes away in every Trackwall window.

## Good to know

- Nothing changed, no strip: you never see an empty summary.
- Until you dismiss it, the strip keeps everything since you first left, also if you leave again and come back.
- Absence is counted per browser profile: the desktop app and a browser tab on the same daemon each keep their own. All windows of the desktop app share one.
- Working in another app counts as being away from Trackwall, which is the point: the strip tells you what happened since you last looked.
- A session whose state Trackwall cannot follow step by step (its hooks do not reach Trackwall) never shows "may be stuck".
- An agent that runs one long step, such as a build of 15 minutes or more, also shows "may be stuck" until the step ends.
- The [supervisor](/features/supervisor) sees "may be stuck" too, and an agent waiting on a task with `wait_for_session` stops waiting when the task's session may be stuck.
