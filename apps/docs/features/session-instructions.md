---
title: Session instructions
description: Every Copilot CLI session you start in Trackwall knows from its first message where it runs, what it can do there and where to read more.
---

# Session instructions

Every Copilot CLI session you start in Trackwall knows from its first message where it runs, what it can do there and where to read more.

## What you get

- Agents that know they run in Trackwall, and in which version, without you explaining it.
- Agents that reach for the right Trackwall tool first, like the repo card instead of reading build files.
- A clear role for each session: the [supervisor](/features/supervisor) coordinates, a session in a repo hands larger work over, a task session stays in its worktree.
- Agents that look up a Trackwall feature in this documentation instead of guessing.
- No changes to your repos or to your Copilot CLI settings.

## How it works

When you start a session in "Sessions", Trackwall gives Copilot CLI a short instruction file before the agent reads your first message. It says that Trackwall started the session, which Trackwall version that is, and that you watch the session in "Sessions" and hear from Trackwall when the agent ends its turn or asks for approval.

The file then gives the session its role. The [supervisor](/features/supervisor) plans work across your repos and hands every piece over as a task proposal instead of changing code itself; it is told it sits in the supervisor panel rather than in "Sessions". A session in a repo works in your own working copy and hands larger or parallel work over as a [task proposal](/features/main-session). A free session in the projects folder is told the repos are your own working copies, that what it changes there gets no review, and to change only what you ask for. A session of an [agent task](/features/tasks) works only in the task's worktree, does not push, verifies its task before it is done and finishes with a summary for you.

Last comes the guide to the [MCP server](/features/mcp): what each tool is for and in which order to use them, how to point you at a repo, session or task with a [trackwall:// link](/features/links), and the address of this documentation with its `llms.txt` index for AI tools. A session you start yourself outside Trackwall gets this guide only as described in [Connect Copilot CLI](/guide/connect-copilot-cli).

## Use it

1. Start a session or a task in "Sessions", or approve a task proposal.
2. Ask the agent what it can do in Trackwall, or just give it work: it already knows.

## Good to know

- The instructions are an addition: Copilot CLI still reads your repo's `AGENTS.md`, `.github/copilot-instructions.md` and your own instruction folders.
- The file lives in Trackwall's own session folder and is removed when you close the session.
- The rules are instructions, not locks: review a task's changes before you push its branch.
- The documentation follows the development version, so it can describe features your Trackwall does not have yet.
- If the path of Trackwall's state folder contains a comma, sessions start without these instructions, because Copilot CLI would read the path wrong.
