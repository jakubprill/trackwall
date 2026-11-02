---
title: Changes across several repos
description: Start one piece of work in several repos at once, one agent per repo, on one branch name, with the order to merge them in.
---

# Changes across several repos

Start one piece of work in several repos at once, one agent per repo, on one branch name, with the order to merge them in.

## What you get

- One form for a change that spans repos, or one card when an agent proposes it, such as a new endpoint and the services and front end that call it, instead of a task per repo typed one by one.
- The same branch name in every repo, so the merge requests of one change are easy to find together on GitLab or GitHub.
- Agents that know their siblings: each one knows the other repos of the change, their tasks and the order to merge them in.
- An agent that follows the repo before it: when the earlier part commits, the next one is told to read what changed.
- Merge requests that point to each other: each one lists the other repos and the order to merge them in, and each part's panel shows all the merge requests of the change.

## How it works

A change is a group of [agent tasks](/features/tasks), one per repo. Press "+" in "Sessions", pick the first repo, keep the "Own worktree" pill on and write the prompt for the whole change. Press "Add a repo" under the options for each other repo, and optionally write what that repo has to do. Then give the change a title, which names its branch. The repos are in the order their merge requests are to be merged: the repo the others build on first, such as the service that provides an endpoint, then the ones that call it.

"Create change in N repos" creates a worktree and a task in each repo, all on the branch `trackwall/<title>-<6 characters>`, and starts an agent in each one. Every agent gets the prompt of the whole change and the note for its own repo. It works only in its own repo, and it knows the other parts: their repos, their tasks and where it stands in the merge order. It reads what another part changed with the same tools an agent uses for work handed on from a task's [impact](/features/impact).

Each part after the first builds on the part right before it. When that part's agent commits and ends its turn, Trackwall asks the next agent to read what changed, so it builds against the new contract. In "Sessions" the parts sit under the first part of the change, in the merge order, and the task panel of each part says "Part of a change".

An agent can propose a change too: the [supervisor](/features/supervisor) or another [main session](/features/main-session) that plans work across repos. The proposal waits in "Sessions" like a task proposal, as one card that lists every repo in the merge order with what it has to do. Read the prompt and the notes, edit them if you like, untick the repos the change should leave out and press "Start change". Each part then reports to the session that proposed it, which follows them like the tasks it proposes. The agent of a task proposes work in other repos as separate tasks instead, which build on its own branch.

Every part is an ordinary task: you review, verify and open its merge request from its own panel, and end it on its own. Above the "Merge request" section, a "Change" section lists every part in the merge order with its merge request and its state. It says which parts to merge first, and warns in yellow when a part was merged before an earlier one, since the repos may not work together until that one is merged too. "Push all parts" pushes the branch of every part that has commits to push, after you confirm, exactly as each part's own "Push" would; it then says which parts it pushed, which had nothing to push and which failed.

When you open a part's merge request, its description starts with the list of the change's parts in the merge order, each with a link to its merge request or "no merge request yet". The merge requests you opened earlier do not know about the later ones, so press "Copy links" and paste the list as a comment on them. Merge them in the order shown. Nothing waits for that order and nothing merges by itself.

## Use it

1. In "Sessions", press "+" and pick the repo the others build on.
2. Write the prompt for the whole change.
3. Press "Add a repo" for each other repo, in the order to merge them, with a note for what that repo has to do.
4. Type a title for the change and press "Create change in N repos".
5. When the parts are done, press "Push all parts" in any part's panel, then open each part's merge request from its own panel, in the merge order.
6. Press "Copy links" and paste the list as a comment on the merge requests you opened before the last one.

When an agent proposed the change, open its card in "Sessions", read and edit the prompt and the notes, untick the repos to leave out, and press "Start change".

## Good to know

- A change has two to six repos, each once.
- A part that cannot start, for example in a repo that is not in your projects folder, is named in the form and the others run. End the parts you no longer want like any task. For a proposed change, the session that proposed it is told which parts could not start.
- A proposed change starts from the proposals panel, not from a grid tile, since you choose its repos there.
- The parts of a change start without [Java navigation](/features/java-navigation); start a task on its own when you need it.
- The merge order is the order you put the repos in. Trackwall does not reorder them, and it does not stop you from merging out of order.
- Trackwall writes nothing on GitLab or GitHub: the list goes into the merge request description you approve, and into the comment you paste. A part you have ended is no longer listed.
- A part's agent does not propose tasks in the other repos of its change. When it needs something from another part, it says so in its summary.
