---
title: Main session and task proposals
description: Let one agent plan work and hand it to other agents, while you approve every task before it starts.
---

# Main session and task proposals

Let one agent plan work and hand it to other agents, while you approve every task before it starts.

![Task proposals from the main session in orders-api, two of them already running as tasks](/screenshots/main-session.png)

## What you get

- A main session that splits a larger job into tasks and proposes them, each with a title and a prompt.
- Every proposal waiting for your decision: read it, edit the prompt or the model, choose whether its task asks for approvals, start it or reject it with a reason.
- Several proposals started with one press; they start one after another.
- The main session following its tasks to the end and reading their summaries and changes.
- The main session woken up when a task moves, and able to send the task's agent a message.

## How it works

Any Copilot CLI session connected to Trackwall can act as a main session, whether it runs in "Sessions" or in your own terminal. The [supervisor](/features/supervisor) is the main session above all repos, with its own panel. When it calls `propose_task`, the proposal appears in "Sessions" as "waiting for your decision", is counted with the waiting sessions on the view bar, shows in the "Needs you" queue on the [Home dashboard](/features/home) and in the tray menu, and flashes the taskbar icon.

All proposals of one session are one entry, indented under that session, which gets a "main" badge with the number of items under it. Select the entry to see who proposed them and each proposal with its full prompt; open a proposal to read and edit it. "Start task" turns it into an ordinary [agent task](/features/tasks). With several proposals, tick the ones you want and press "Start N selected"; a proposal can be ticked once you have opened it. "Reject…" asks for an optional reason, which goes back to the main session so it can propose something else. Nothing starts until you decide.

A task's agent finishes with a summary, shown above the task's tabs. The main session does not need to keep asking about its tasks: when a task's agent finishes a turn, reports its result, gets a verification verdict, errs or stops, or when you reject a proposal, Trackwall types one line into the main session asking it to read what happened, once it waits for input. It then reads the summaries and changes, down to the diff of the files it cares about, so it can check the work and plan the next step.

To steer a running task, the main session sends its agent a message: a correction, an answer to the agent's question, or what changed in another repo. The task's agent is asked to read it the same way, once it waits for input, or when you resume the task. The agent takes a message as an update of its task: where it differs from the task's prompt, it follows the message, but what you type into the task's terminal or send as a review comes first. The messages appear in the task's panel under "Messages", with who sent them and whether the agent has read them yet.

![Two messages from the main session in orders-api to its notifications task, the second not read yet](/screenshots/task-messages.png)

## Use it

1. Start the [supervisor](/features/supervisor), or a session in "Sessions" (or run `copilot` with the Trackwall MCP server in your projects folder).
2. Describe the larger job and ask the agent to split it into task proposals.
3. Open the proposals, edit the prompts if needed, and start the ones you want.
4. Let the main session collect the results.

## Good to know

- A proposal can name the Copilot CLI model its task runs on, for example a stronger one for a code review. The model shows in a field among the pills under the prompt: change it, or clear it to use Copilot CLI's default. Most proposals leave it empty. The task keeps its model when it is resumed, and its panel shows it next to the task port. Switching the model with `/model` in the task's terminal lasts until the task is resumed, which goes back to the task's model. Turn on "Chat (preview)" among the same pills to start the task as a conversation instead of a terminal ([agent tasks](/features/tasks)).
- A proposal can suggest running its task without asking for approvals: its "No approvals" pill is then on, with what that means under it. Turn it off to keep the approvals. In the session grid such a proposal cannot be started from its tile: open it, so you see the pill before you start it.
- A proposal for a repo that already has tasks says so.
- A main session can also propose removing a repo, shown as "Repo removal" with its reason and a "Remove repo" button instead of a prompt; see the [supervisor](/features/supervisor).
- In the session grid, a tile with proposals shows their prompts with "Start task" and "Reject…"; "Next waiting" and Alt+J go to proposals too.
- Proposals last until Trackwall quits, at most 20 at a time; summaries stay with their tasks.
- A proposal from an agent outside Trackwall is marked "agent outside Trackwall" and listed at the top level, like a proposal from a session you have closed. Such an agent can propose tasks, but cannot report a task's summary, is not woken when its tasks move and cannot send them messages; it has to keep checking on them itself.
- Prompts, titles, summaries and messages cannot contain invisible characters, so what you read is the whole text.
- A session sends messages only to the tasks it proposed. A task you typed yourself, or one another session proposed, takes no messages from it.
- A task can hand work to another repo: when its change has callers there, its agent commits the change, asks Trackwall which endpoints its commits changed and which repos call them, and proposes a task in each of those repos. The proposed task is told by Trackwall which task handed it the work, on which branch and at which commit, and reads that task's changes before it builds on them, so a prompt that forgets to say where the change is does not leave it guessing. When the handing task commits again, for example after you asked it to rename a field, the proposed task is asked to look at the new commits once its own turn ends, and sees which files they changed. If you end the handing task first, the proposed task is told that too.
- A task can propose tasks of its own. They stay with it when you stop and resume it: its new session sends them messages, hears about them, and keeps them under it in the Sessions list.
- Copilot CLI asks you to allow each message a session sends, as it does for any tool that changes something; choose "don't ask again" to let it steer its tasks on its own. Reading messages and news needs no approval.
- After five messages to a task without you, the main session has to ask you before it sends more. Typing anything into the main session or the task, or sending the task a review, counts as you taking part.
- A turn you drive yourself by typing in the task's terminal does not wake the main session, since you are handling it. Neither does a task asking for approval: that is for you, in the tray panel.
- Messages and updates last until Trackwall quits; up to 20 messages per task are kept.
