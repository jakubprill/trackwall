---
title: Routines
description: Save a task you repeat, such as updating an API client and checking it compiles, and run it again with one click.
---

# Routines

Save a task you repeat, such as updating an API client and checking it compiles, and run it again with one click.

## What you get

- A list of your routines under the "New task" form in "Sessions", each with a "Run" button.
- Routines written by an agent that looked at your repo first, so they name the real files, commands and checks.
- Every run is an ordinary [agent task](/features/tasks): its own branch and worktree, Verify, review, and a summary at the end.
- Nothing runs that you have not read: a new or changed routine waits for "Approve this version".

## How it works

Ask an agent in any session or the [supervisor](/features/supervisor) to prepare a routine, and describe what you want, for example "prepare a routine that downloads the new OpenAPI spec of the orders service, regenerates our client, compiles the frontend, and tells me what changed and whether it is safe to merge". The agent looks at the repo and the tools Trackwall gives it. Fixed steps, such as the download and the compile, it suggests as a [mise task](/features/mise-tasks), so every run does exactly the same; the routine's prompt keeps only what needs judgement. Then it saves the routine.

The routine appears under "Routines" below the "New task" form, with its prompt open and "needs your approval". Read it, then press "Approve this version". From then on "Run" starts a task with the routine's prompt, repo, model and approvals mode. The task's agent ends with a summary: what happened, what changed, and its recommendation, for example a merge request or what a developer has to look at. You see it in the task and in [While you were away](/features/while-you-were-away).

When the routine changes, whether an agent saved a new version or someone edited its file, it waits for your approval again and shows the new prompt. Trackwall also refuses to approve or run a version other than the one on your screen.

## Use it

1. In a session, ask the agent to prepare a routine and say what it should do and how to judge the result.
2. Open "Sessions" and press "+" for the "New task" form; the routine is under "Routines".
3. Read its prompt and press "Approve this version".
4. Press "Run" whenever you want it done.

## Good to know

- Each routine is a Markdown file in `.trackwall/routines` of your projects folder: the title, repo, model and approvals mode at the top, the prompt below. You can read and edit it in any editor; an edit needs a new approval.
- A routine runs only when you press "Run". There is no schedule yet.
- A run never pushes or opens a merge request by itself; you do that from the task, as with any task.
- A routine works in one repo. Work across several repos is still a task per repo, or the supervisor.
- A routine marked "runs without approvals" starts its task in that mode; you see the mark before you approve it.
- Keep secrets out of a routine: it names environment variables, never their values.
