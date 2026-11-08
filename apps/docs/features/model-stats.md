---
title: Model statistics
description: See which model passes verification most often on your own tasks, and what one task and one verified task cost on it.
---

# Model statistics

See which model passes verification most often on your own tasks, and what one task and one verified task cost on it.

![The Models section in Settings, with four models, how often their tasks passed verification and what one cost, and a sentence naming the model that passes most often and the cheapest one per verified task.](/screenshots/model-stats.png)

## What you get

- For every model your ended tasks ran on: how many tasks, how many passed or failed their last verification, and how many left commits.
- What one task cost on average, and what one verified task cost once the failed and unverified ones are paid for too.
- One sentence that names the model that passes verification most often and the one that costs the least per verified task.
- The tasks Copilot CLI ran on another model than the one you started them on, so a quiet switch does not hide in the numbers.

## How it works

When you end a task, Trackwall keeps a short record of it (see [Agent tasks](/features/tasks)), with the model Copilot CLI really ran it on, its last verification and what its conversation used. "Models" in "Settings > Usage" groups those records by model, for the tasks you ended in the last 30 or 90 days, or for all of them.

A task counts for the model that made most of its calls. If you started a task on one model and Copilot CLI ran it on another, because your account does not offer the first, the task counts for the model that did the work, and its row says how many tasks were started on another model. A task you moved to another model half way counts once, for the model that made more of its calls.

"Verified" is a task whose last [Verify](/features/tasks) passed; "Failed", one whose last Verify failed. A task you never verified is in neither. "Per task" is the average of what the model's tasks used, the same way a session shows its [usage](/features/sessions): AI credits, premium requests, or only tokens with a model of your own provider. "Per verified task" divides everything the model's tasks used by the tasks that passed, so a cheap model that often fails costs more per verified task than per task.

The sentence above the table compares only models with five tasks or more. With fewer, a single failure changes the share by a fifth or more, so such a row says "too few tasks to compare" and stays out of the sentence.

## Use it

1. End a few tasks on each model you want to compare, and press "Verify" before you end each one.
2. Open "Settings" (Ctrl+, or ⌘, on macOS), choose "Usage" and find "Models" under "Copilot usage".
3. Read the sentence above the table, then pick "90 days" or "All" when the last 30 days have too few tasks.
4. Start your next task on the model that fits it: the one that passes most often for work that must land, the cheapest per verified task for routine changes.

## Good to know

- Only tasks you ended count. A task that still runs, or one whose worktree you removed by hand, is not in the statistics yet.
- Tasks you ended before Trackwall recorded the model are counted under the table and in no row.
- Verify is the only outcome Trackwall can check by itself. Whether you merged the branch is not known to it, so "With commits" only says the task left work behind.
- Comparing models is fair only on similar work: a model you keep for hard changes fails more often than one you use for small ones.
- The records stay on your computer, in `task-journal.jsonl` in Trackwall's state folder (`~/.trackwall`, on Windows `%USERPROFILE%\.trackwall`); nothing is sent anywhere.
