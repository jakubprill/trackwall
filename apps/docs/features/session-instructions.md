---
title: Session instructions
description: Every Copilot CLI session you start in Trackwall knows from its first message where it runs, what it can do there and where to read more.
---

# Session instructions

Every Copilot CLI session you start in Trackwall knows from its first message where it runs, what it can do there and where to read more.

## What you get

- Agents that know they run in Trackwall, and in which version, without you explaining it, and start with your approved [workspace knowledge](/features/knowledge).
- Agents that reach for the right Trackwall tool first, like the repo card instead of reading build files.
- A clear role for each session: the [supervisor](/features/supervisor) coordinates, a session in a repo hands larger work over, a task session stays in its worktree, and a task you run alone gets a short version that costs fewer tokens.
- Agents that look up a Trackwall feature in this documentation instead of guessing.
- No changes to your repos or to your Copilot CLI settings.

## How it works

When you start a session in "Sessions", Trackwall gives Copilot CLI a short instruction file before the agent reads your first message. It says that Trackwall started the session, which Trackwall version that is, and that you watch the session in "Sessions" and hear from Trackwall when the agent ends its turn or asks for approval.

The file then gives the session its role. The [supervisor](/features/supervisor) plans work across your repos and hands every piece over as a task proposal instead of changing code itself; it is told it sits in the supervisor panel rather than in "Sessions". A session in a repo works in your own working copy, so it changes only what you ask for and leaves its branch, commits and pushes to you unless you ask, and it hands larger or parallel work over as a [task proposal](/features/main-session). A free session in the projects folder is told the repos are your own working copies, that what it changes there gets no review, and to change only what you ask for. A session of an [agent task](/features/tasks) works only in the task's worktree, does not push, verifies its task before it is done and finishes with a summary for you. A task that is part of a [change across several repos](/features/changes) also learns the other parts, their repos and tasks, and the order to merge them in.

A task you start yourself, in one repo, that no agent proposed and that is no part of a change, is a solo task: its agent gets only the short version of the task's role (stay in the worktree, leave the round commits alone, verify, report) and one line saying it can propose work in another repo if its change needs it. The instructions go with every call the agent makes to its model, so text about work it will not do would cost tokens in each call. Its Trackwall tools stay available all the same.

Then come the [workspace knowledge](/features/knowledge) entries you approved about the session's repo and your whole workspace, as your notes rather than rules, so the agent starts with what earlier agents had to find out.

Last, except in a task's session, comes the guide to the [MCP server](/features/mcp): what each tool is for and in which order to use them, how to point you at a repo, session or task with a [trackwall:// link](/features/links), and the address of this documentation with its `llms.txt` index for AI tools. A task's agent does without it, because its role already names the tools it works with, and a task on several repos runs as several sessions that would each pay for the guide in every call. A session you start yourself outside Trackwall gets this guide only as described in [Connect Copilot CLI](/guide/connect-copilot-cli).

## Use it

1. Start a session or a task in "Sessions", or approve a task proposal.
2. Ask the agent what it can do in Trackwall, or just give it work: it already knows.

## Good to know

- The instructions are an addition: Copilot CLI still reads your repo's `AGENTS.md`, `.github/copilot-instructions.md` and your own instruction folders.
- The file lives in Trackwall's own session folder and is removed when you close the session.
- A solo task you later hand to the supervisor gets the full instructions from its next session on; messages and reviews reach the agent either way, because Trackwall's prompt names the tool that reads them.
- The rules are instructions, not locks: review a task's changes before you push its branch.
- The documentation follows the development version, so it can describe features your Trackwall does not have yet.
- If the path of Trackwall's state folder contains a comma, sessions start without these instructions, because Copilot CLI would read the path wrong.
