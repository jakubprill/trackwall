---
title: Automatic review
description: Let Copilot CLI review an agent task's changes before you verify and open a merge request, and turn its findings into review comments.
---

# Automatic review

Let Copilot CLI review an agent task's changes before you verify and open a merge request, and turn its findings into review comments.

## What you get

- A second pair of eyes on every task: Copilot CLI's own review agent reads the task's changes and reports only bugs, security holes and other issues that matter.
- Findings next to the diff, each with its file, line and suggested fix, that become a review comment on that line with one click.
- A reviewer that only reads: it cannot run commands, change files or use your MCP servers, and every request for more is refused.
- A choice of when it runs: on a click, or on its own as soon as the task's agent reports that it is done.

## How it works

Open an [agent task](/features/tasks) and its "Changes" tab. Above the diff, the "Automatic review" section has a "Review" button. Press it, and Trackwall starts Copilot CLI in the task's worktree with the built-in `/review` and the task's whole change: its commits since it started and the files it has not committed yet. The section says "reviewing" while it works, usually a minute or two, and "Cancel" stops it.

When it ends, the section lists the findings, each with how serious it is, its title, its file and line, the problem and the suggested fix. "Add to review" puts a finding into the review list above the diff, as a comment on its line, with the title over the text. Add your own comments next to it, or remove it from the list; nothing reaches the agent until you press "Send N comments to the agent", as with any review. A finding on a line the diff does not show cannot become a comment; tell the agent in its session instead. "The reviewer's answer" shows the review as Copilot CLI wrote it, also when it found nothing or answered in another shape.

To have every task reviewed without a click, turn on "Review a task's changes when its agent reports its result" in "Settings > Agents". The review then starts when the task's agent reports its result, which it does once it has finished and verified its work, so the findings are there when you come to verify and open the merge request. A report with the same changes as the last finished review does not start another one.

The reviewer is not a session: it does not show in "Sessions" and you cannot write to it. It gets only the tools that read and search files, and no MCP servers. When it asks for anything more, such as a file outside the task, Trackwall says no for you, and the section names what was refused, since the review may have stopped short.

## Use it

1. Open a task's "Changes" tab and press "Review" in the "Automatic review" section.
2. When it ends, press "Add to review" on the findings you agree with.
3. Press "Send N comments to the agent".

To review every task when its agent reports, turn on the setting in "Settings > Agents".

## Good to know

- Every review costs model credits from your Copilot plan or your own model provider, the same as a turn of a session. That is why it is off until you press "Review" or turn the setting on.
- The reviewer runs with the same Copilot CLI, account and [session profile](/features/mise-environment) as the task's sessions, and sends the change to the same model provider.
- A change larger than 512 KB is cut: the reviewer gets only its first part, and the section says so.
- "Review again" replaces the last review. Trackwall keeps the last review of each task, also when it restarts or updates; one that was still running then shows as cancelled.
- Ending a task stops its review.
- The reviewer can read the task's worktree and your system's temporary folder, which Copilot CLI lets every session read. Copilot CLI also reads the repo's own instructions for agents, such as `AGENTS.md`, as in any session.
