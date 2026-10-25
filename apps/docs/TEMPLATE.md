# Feature page template

Every page in `features/` follows this template, so a reader who knows one page knows them all, and the "All features" list, the sidebar and `llms.txt` stay complete. Copy the block below into `features/<feature>.md`, add the page to its group in `.vitepress/sidebar.ts` (the groups are also the sections of "All features"), and fill it in. `test/pages.test.ts` checks the frontmatter, the title and lede, the sections and their order, the length of "What you get", the sidebar and the home page cards, and that no page points at decision records or the developer documents.

The page is done when a colleague who has never opened Trackwall can read it aloud in a technical meeting and everyone in the room knows what the feature gives them, how to use it and where it stops.

## How to write it

- **Write for the person using Trackwall.** Say what they see and do: views, buttons and keys by the names in the app, in quotation marks. Leave out how it is built (protocols, modules, processes, file formats) unless the reader acts on it, like a path they edit.
- **Lead with the value.** The description and "What you get" say what changes for the reader, in their words: "see which agent is waiting for you", not "session state from hooks".
- **Short sentences, one idea each.** Bullets for lists of things, prose for how things fit together, a table for keys or options.
- **Every fact on one page.** A fact that belongs to another feature is a link to that page, not a copy.
- **Show it.** A screenshot under the lede shows the feature at work on the demo shop, a made-up projects folder with twenty repos and sessions in every state. Add or update a picture in `scripts/screenshots.ts` and run it (the command is at the top of the script); never take one from your own repos.
- **Only what Trackwall does today.** No plans, no history, no decision records and no links into `docs/`: the page describes the delivered feature, and whatever the reader needs is on the site.

The pages in `guide/` (what Trackwall is, installing it, connecting Copilot CLI) are not features and keep their own shape: the same frontmatter and lede, then the steps the reader follows. The same rules of writing apply to them.

## The page

```md
---
title: <Feature name, as in the sidebar>
description: <One sentence, under 160 characters: what the reader can do with it. Shown in "All features", in search results and in llms.txt.>
---

# <Feature name>

<The description sentence again, as the lede.>

![<What the picture shows, as a sentence.>](/screenshots/<name>.png)

## What you get

- <3 to 5 bullets: what the reader can do now that they could not before. One line each.>

## How it works

<Two to four short paragraphs that walk through a typical use, in the order the reader meets it. Name what they see on screen.>

## Use it

1. <The shortest path from nothing to the feature working, as numbered steps. One action per step.>

## Shortcuts

<Optional, and the only kind of section between "Use it" and "Good to know": a table the reader looks things up in, either keys ("Shortcuts") or agent tools ("Tools"). Omit it when the feature has none. A new kind of table is added to `REFERENCE_SECTIONS` in `test/pages.test.ts`.>

| Keys | What happens |
|---|---|

## Good to know

- <Limits, requirements and surprises, one per bullet: what it needs installed, what it does not do, where data lives when the reader may look for it.>
```
