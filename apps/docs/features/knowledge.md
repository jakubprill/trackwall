---
title: Workspace knowledge
description: Keep short facts about your repos that every agent reads at the start, so no session has to find them out again.
---

# Workspace knowledge

Keep short facts about your repos that every agent reads at the start, so no session has to find them out again.

## What you get

- Agents that already know how a repo's integration tests run, which repos talk through a queue, or which test is flaky.
- Fewer turns spent rediscovering the same thing in every task.
- Facts that agents propose while they work, which you approve, edit or remove.
- Nothing reaches an agent that you have not read: a new or changed entry waits for "Approve this version".

## How it works

Workspace knowledge is a list of short entries in "Plan", under "Workspace knowledge" on the left. Each entry is one fact of one kind: **How to** (how to build, run or test something), **Relation** (a link between repos that the [connection graph](/features/graph) does not show, such as a queue or a shared database), **Exception** (where a repo departs from a rule it would otherwise follow) or **Pitfall** (a trap, such as a test that needs something first). An entry is about some repos, or about your whole workspace when it names none.

When an agent finds out something that cost it work, for example that `mise run test` skips the integration tests and `mise run test-it` runs them, it can propose an entry. The list shows the proposals under "Needs your approval", apart from the approved entries, one line each: its kind, the fact, its repos, who wrote it and when, and a warning mark when something needs a second look. The left column counts the proposals next to "Workspace knowledge". Select one to read it in full on the right, with the agent's evidence and hints for what to look at twice: a web address, text that reads like an instruction to agents rather than a fact, or something that looks like a secret. Press "Approve this version" there, or remove it. You approve one entry at a time, after reading it: there is no "Approve all", since every entry reaches your agents.

Search the facts by any words in them, their name or repos, and narrow the list to one kind or one repo; an entry about your whole workspace shows for every repo.

Every [Copilot CLI session](/features/sessions) and [agent task](/features/tasks) you start afterwards gets the approved entries about its repo, and the ones about your whole workspace, in its [session instructions](/features/session-instructions). The [supervisor](/features/supervisor) gets the ones about the whole workspace. Agents can read the rest with the `list_knowledge` tool of the [MCP server](/features/mcp).

You can also write an entry yourself with "New entry" at the top of the list. Your own entries count as soon as you save them.

## Use it

1. Open "Plan" and choose "Workspace knowledge" on the left.
2. Select a proposal under "Needs your approval", read it and its evidence on the right, and press "Approve this version" when it is right.
3. To add a fact yourself, press "New entry", fill in a name, a kind, the repos and the fact, and press "Save".
4. Start a session or a task in a repo: its agent starts with what you approved.

## Good to know

- A fact about one repo that its team would agree with belongs in that repo's own `AGENTS.md` or Copilot instructions, where everyone reads it. Workspace knowledge is for facts between repos, about your own machine, or about repos you cannot change.
- Each entry is a Markdown file in `.trackwall/knowledge` of your projects folder. You can edit it in any editor; an edited entry waits for your approval again before agents read it.
- Agents read entries as your notes, not as rules: when an entry no longer matches what an agent sees, it proposes a correction under the same name.
- A running session keeps the entries it started with; a session or task you start or resume later gets the new ones.
- An entry holds up to 500 characters. A session's instructions take the entries that fit in about 4000 characters, its own repo's first.
- Keep secrets out of entries: agents and their logs would see them.
