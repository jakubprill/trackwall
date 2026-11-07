---
title: Plan
description: Write ideas down before they slip away, split business projects into tasks and start an agent task on any of them in two clicks.
---

# Plan

Write ideas down before they slip away, split business projects into tasks and start an agent task on any of them in two clicks.

## What you get

- An idea written down in a second from any view: Alt+N, type, Enter, and you are back where you were, even in a session terminal.
- Your business projects split the way your team splits them, from business tasks down to technical ones, as an outline you rearrange with the keyboard.
- "Start task" on any item: the task form opens with the item's repo and a prompt made of its title, notes and where it sits in the project, and the task stays linked to the item.
- Agents that keep notes for you: an agent can write an idea or a smaller piece of work it found into your plan while it works, and read the plan of the item its task is for.

## How it works

"Plan" has three columns. On the left are the "Inbox" with the number of ideas still to sort, your [workspace knowledge](/features/knowledge), your active projects, and a line to add a project. In the middle is the selected place: the inbox's ideas, or a project's items as an outline. On the right is the selected item: its title, its plan and notes, a link to its ticket, its column ("Idea", "Ready", "In progress", "In review", "Done", "Dropped"), the repos it is about, and the tasks started on it.

Press Alt+N anywhere in Trackwall to write an idea. Enter saves it into the inbox, and the keyboard goes back where it was. You can also type an idea into the line at the top of the inbox.

The inbox is where you sort ideas. It shows the newest first, grouped into "Today", "This week" and "Older", and each idea says who wrote it (you, or an agent and the task it was working on), when, the repos it is about and the first line of its notes. "All", "From agents" and "Mine" narrow the list. The newest idea is selected when you open the inbox, so the right column shows it at once. On the selected idea:

- "File in…" lists your active projects; pick one and the idea becomes an item at the end of that project. Projects that already have items in the idea's repos come first and say so ("also works in shop-bff"). The same list is in the right column under "File in a project".
- "Start task" opens the task form for the idea, as on any item.
- "Drop" puts the idea under "Dropped" at the bottom of the inbox, folded. Open it to read a dropped idea again or "Restore" it.

After you file or drop an idea, the next one is selected, so you can sort the whole inbox from the keyboard: J and K (or ↓ and ↑) move, F opens "File in…" and a digit picks the project, S starts a task and D drops.

A project shows how far it is at the top: "2 of 9 done", a bar coloured by what is done, in review and in progress, the number of items in each column, and how many of its tasks wait for you. "Hide done" hides what is done or dropped, with what it was split into, and the count takes those as done or dropped too. Each row shows the item's repos, what its task is doing now (a task waiting for you comes before a newer one) ("working", "waiting for you", "In review", "Verified", a merge request such as "!42"), and on an item split into others how many of them are done ("1/4"). In the left column every project shows the same count and a dot while one of its tasks waits for you.

"Board" at the top of a project shows the same project as columns: "Idea", "Ready", "In progress", "In review" and "Done". Each card is an item not split further, with the item it was split from above its title, its repos and what its task is doing. A card follows its tasks into "In progress" and "In review" by itself; drag it to another column (Esc while dragging puts it back), or click it and press Alt+← and Alt+→, to move it yourself. Dropped items are counted under the board, an item below a done one sits under "Done" with it, and "Hide done" hides the "Done" column. The board stays on when you switch projects. "Outline" brings the tree back, where you split and rearrange the work.

On the right you read the selected item first: where it sits in its project, its title, its notes formatted as Markdown and a "Ticket" button when it has a link. "Edit" turns them into fields, and "Save" or "Cancel" turns them back. Below are the items it is split into with their columns, and its tasks as cards with their state, verdict and merge request, each with "Open"; an item split into others also lists the tasks started on those under "Tasks below".

To split an item, type into the line under its notes ("Split: a new item under this one") and press Enter. In the outline, Tab puts the selected item under the one above it, Shift+Tab takes it out a level, and Alt+↑ and Alt+↓ move it among its neighbours. Click the arrow in front of an item to fold what is under it.

"Start task" on an item opens the task form with the item's first repo and a prompt that starts with where the item sits ("Part of: Checkout redesign › Pay later") followed by its title and notes. Change anything you like and start it. The task shows in "Sessions" as usual, and under "Tasks" of the item, and the item moves to "In progress". An agent working on that task can read its item and the items around it, and when it writes down something for later, the new item lands under its task's item, marked as written by an agent.

The item then follows its tasks. When the agent says it is done (it reports its summary), the item moves to "In review", or, with several tasks on the item, once every one of them has reported. When you send the agent a review or press "Fix" on a failed pipeline, or the session that proposed the task sends it a message, the item goes back to "In progress". Ending the one task still at work while the others wait for review moves the item to "In review" too. Marking it "Done" or "Dropped" stays with you, and an item you closed stays where you put it. You can still set any column yourself.

## Use it

1. Press Alt+N, type an idea and press Enter.
2. Open "Plan" (Ctrl+5) and add a project in the line under "Projects".
3. Open "Inbox", press F on the idea and the number of the project.
4. Split it in the line under its notes, and pick a repo under "Repos".
5. Press "Start task" on the item you want an agent to do, check the prompt and start it.

## Shortcuts

| Keys | On macOS | What happens |
|---|---|---|
| Alt+N | ⌥N | Write an idea into the inbox, from any view. |
| Ctrl+5 | ⌘5 | Open "Plan". |
| J, K or ↓, ↑ | J, K or ↓, ↑ | In the inbox: select the next or the previous idea. |
| F, then 1–9 | F, then 1–9 | In the inbox: file the selected idea in the project with that number. |
| S | S | In the inbox: start a task on the selected idea. |
| D | D | In the inbox: drop the selected idea. |
| Tab, Shift+Tab | Tab, ⇧Tab | On a selected item in the outline: put it under the one above, or take it out a level. |
| Alt+↑, Alt+↓ | ⌥↑, ⌥↓ | Move the selected item up or down among its neighbours. |
| Alt+←, Alt+→ | ⌥←, ⌥→ | On a card of the board: move it to the column on the left or right. |

## Good to know

- Each item is a Markdown file in `.trackwall/board/` of your projects folder, next to your repos, so it survives a rebuilt container and you can read it in an editor. Removing an item deletes its file, and nothing keeps a copy.
- Nothing in "Plan" starts work by itself. Agents can write ideas and items and move them between "Idea" and "Ready", and their task's item goes to "In review" when they report, but only you create projects, move items in the outline, start tasks or mark something done.
- An item with items under it cannot be removed; move or remove those first. "Archive project" moves a finished project under "Archived".
- The agent tools are listed on the [MCP server](/features/mcp) page.
- On a Mac keyboard layout where ⌥N types a character, the key types it as usual and the shortcut stays off.
