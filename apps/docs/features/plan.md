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

"Plan" has three columns. On the left are the "Inbox" with the ideas you have not filed yet, your active projects, and a line to add a project. In the middle is the selected place: the inbox's ideas, or a project's items as an outline. On the right is the selected item: its title, its plan and notes, a link to its ticket, its column ("Idea", "Ready", "In progress", "In review", "Done", "Dropped"), the repos it is about, and the tasks started on it.

Press Alt+N anywhere in Trackwall to write an idea. Enter saves it into the inbox, and the keyboard goes back where it was. When you are ready to deal with an idea, select it and choose a project under "Filed in"; it becomes an item at the top of that project.

To split an item, type into the line under its notes ("Split: a new item under this one") and press Enter. In the outline, Tab puts the selected item under the one above it, Shift+Tab takes it out a level, and Alt+↑ and Alt+↓ move it among its neighbours. Click the arrow in front of an item to fold what is under it.

"Start task" on an item opens the task form with the item's first repo and a prompt that starts with where the item sits ("Part of: Checkout redesign › Pay later") followed by its title and notes. Change anything you like and start it. The task shows in "Sessions" as usual, and under "Tasks" of the item. An agent working on that task can read its item and the items around it, and when it writes down something for later, the new item lands under its task's item, marked as written by an agent.

## Use it

1. Press Alt+N, type an idea and press Enter.
2. Open "Plan" (Ctrl+5) and add a project in the line under "Projects".
3. Select the idea in "Inbox" and choose the project under "Filed in".
4. Split it in the line under its notes, and pick a repo under "Repos".
5. Press "Start task" on the item you want an agent to do, check the prompt and start it.

## Shortcuts

| Keys | On macOS | What happens |
|---|---|---|
| Alt+N | ⌥N | Write an idea into the inbox, from any view. |
| Ctrl+5 | ⌘5 | Open "Plan". |
| Tab, Shift+Tab | Tab, ⇧Tab | On a selected item in the outline: put it under the one above, or take it out a level. |
| Alt+↑, Alt+↓ | ⌥↑, ⌥↓ | Move the selected item up or down among its neighbours. |

## Good to know

- Each item is a Markdown file in `.trackwall/board/` of your projects folder, next to your repos, so it survives a rebuilt container and you can read it in an editor. Removing an item deletes its file, and nothing keeps a copy.
- Nothing in "Plan" starts work by itself. Agents can write ideas and items and move them between "Idea" and "Ready", but only you create projects, move items in the outline, start tasks or mark something done.
- An item with items under it cannot be removed; move or remove those first. "Archive project" moves a finished project under "Archived".
- The agent tools are listed on the [MCP server](/features/mcp) page.
- On a Mac keyboard layout where ⌥N types a character, the key types it as usual and the shortcut stays off.
