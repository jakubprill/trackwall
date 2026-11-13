---
title: Conversation view
description: Follow an agent as a conversation you can scroll, select and copy, with its commands, file changes and approvals as rows you can open.
---

# Conversation view

Follow an agent as a conversation you can scroll, select and copy, with its commands, file changes and approvals as rows you can open.

## What you get

- The agent's answers as formatted text (headings, lists, code, tables) instead of a terminal screen, so you can scroll, select and copy them like any page.
- Each command or file change as a row you can open, a file change as a diff in colour, and an approval request with buttons right below it.
- A message box that takes your next message while the agent still works, and sends it when its turn ends.
- The files a turn changed in a panel beside the conversation, with a button to ask the agent about any line.
- Screenshots, logs and other files attached to a message, and the agent's slash commands listed as you type.

## How it works

The conversation view is a preview. Pick "Chat (preview)" under "Show as" before you start the [supervisor](/features/supervisor), or turn on the "Chat (preview)" pill in the New session form for an [agent task](/features/tasks) or a [session](/features/sessions), or on a [task proposal](/features/main-session), and the agent opens as a conversation instead of Copilot CLI's terminal. Trackwall remembers your choice, also for "Start my day". For the supervisor, "Continue" goes on with the same conversation in either view, so you can switch back to the terminal at any time; a task keeps its view for every resume, also after Trackwall restarts, and shows it in its "Chat" tab in place of "Terminal".

Your messages are bubbles on the right. Each turn of the agent is one block under its name, with its answers formatted and each tool it calls as a row with an icon for its kind, the command it runs or the files it works on, and its state; the row opens to show the details. A file change opens as a diff, with the number of lines it adds and removes on the row, and an approval to change a file shows that change before you allow it. "Thought" above an answer opens the agent's reasoning, when the model gives it. When the agent hands work to a subagent, the row shows "Subagent" and its type, and opens to show what it was asked and its answer.

An approval request takes the keyboard when it shows, unless you are in the middle of writing a message: ↑ and ↓ move between its answers and Enter picks one, as in the terminal. A line above the message box says whose turn it is: "The agent is working…", "The agent asks for your approval" or "Your turn: the agent waits for your message". What you write while the agent works shows at once as a dashed bubble marked "Waiting" and goes as soon as it finishes the turn; reviews and messages for a task go in the same way. "Stop the turn", shown in the box while the agent works, stops its answer while the session goes on running. Next to that line, "Agent" and "Plan" switch the agent's mode, as Shift+Tab does in the terminal, and a meter shows how much of the model's context the conversation uses; it turns yellow from 75%, a good time to send `/compact`.

When the panel is wide enough, "Show diff" beside a file change opens "Changes of the turn" beside the conversation: the files that turn changed, one button each, and the picked file's diff with line numbers. The button in front of a line offers "Ask about this" on any line, which puts the file, the line and its text as a quote in front of your message, and "Open in VS Code" at that line on the latest change of a file. In a task it also offers "Comment" on the lines a change added, which adds a review comment you send from the top of the panel just as in "Changes". The panel is closed until you open it, and ✕ closes it; in a narrow panel, such as a grid tile, the change stays in its row.

## Use it

1. Open the supervisor panel (Alt+0), or press "+" in "Sessions" for a task or a session.
2. Pick "Chat (preview)" and start it.
3. Write in the box at the bottom and press Enter (Shift+Enter for a new line).
4. Open a row to see a command or a file change, and answer an approval with its buttons or with ↑, ↓ and Enter.
5. Press "Show diff" beside a file change to see everything the turn changed.

## Good to know

- Autopilot is not on the mode switch, because it lets the agent do everything without asking, also outside the repo; type `/autopilot` when you want it.
- A slash at the start of your message lists the agent's commands: ↑ and ↓ pick one, Tab or Enter puts it in the box, Esc closes the list.
- To show the agent a screenshot, paste it into the box. The paperclip next to it attaches images (PNG, JPEG, GIF, WebP) and text files such as a log, up to five of 10 MiB together. They show as names above the box, each with × to take it off, and under your message once sent.
- Links in an answer open in your browser, and images show only as their description.
- [Java navigation](/features/java-navigation) needs the terminal for now, so its pill is off while "Chat (preview)" is on.
- The box grows with your text and goes away once the session stops. The "Changes" tab of a task still has its whole diff.
