---
title: Repo card and tags
description: See what a repo is made of, read from its build and configuration files, without building it.
---

# Repo card and tags

See what a repo is made of, read from its build and configuration files, without building it.

![The card of orders-api: tags, mechanisms, its app and its HTTP endpoints](/screenshots/repo-card.png)

## What you get

- The packages a repo builds and the packages it uses, from Maven, Gradle and npm.
- Its Spring Boot apps with their ports, its HTTP endpoints with request and response types, and the fields of those types.
- The HTTP clients it uses and the addresses they call.
- The tools and frameworks it needs, such as mise, Node, Spring Boot, Feign, Kafka, Helm or React.
- Tags on the repo list, such as `java`, `frontend` or `library`, and a filter by tag.

## How it works

Select a repo and open its "Card" tab. Trackwall reads the build and configuration files of the latest commit and lists what it finds, every fact with the file and line it comes from. Nothing is built or run, so the card is there even for a repo you have never set up.

The card covers the packages the repo provides and uses, required tools (`mise.toml`, `.tool-versions`, `.nvmrc`, build wrappers), frameworks, Spring Boot apps and their ports, HTTP endpoints from controllers with their request and response types, the fields of those types (Java records and classes, Kotlin `data class`, enums), and HTTP clients (Feign, `@HttpExchange`, WebClient, RestClient, RestTemplate) with the addresses from `application*.yml` in every profile, from `.env` and from the frontend's dev proxy.

From the card Trackwall gives each repo tags: `java`, `typescript`, `frontend`, `backend`, `bff`, `library`, `monorepo`, and `no-mise` for a repo without mise tasks. The tags show on the repo list, with the reason in a tooltip, and the filter above the list narrows it to repos that have every tag you select.

## Use it

1. Open "Repos" and select a repo.
2. Open the "Card" tab.
3. To narrow the list, pick tags in the filter above it.

## Good to know

- A card is computed once per commit and kept in `~/.trackwall/cards`, so it opens instantly the next time.
- You do not have to open anything first: when Trackwall starts, and after every commit, checkout or pull, it computes the missing cards in the background, two repos at a time, the repos you worked in most recently first. "Repo cards" in the "Daemon" view says how far it is ("computing 12 of 80", then "up to date").
- A card describes the last commit, so a change you have not committed yet is not on it.
- When a card is missing something, "Incomplete" at its top says what and why: a file not read (the repo is larger than the card reads), an invalid file (a `pom.xml` or `package.json` that does not parse), code not parsed (endpoints without request and response types), or a list cut short.
- `no-mise` shows as the warning "no mise tasks": the setup and build steps of the [Batch command](/features/batch-command) and the [mise tasks](/features/mise-tasks) tab have nothing to run in that repo.
- Add your own tags under `repoTags` in `~/.trackwall/workspace.yaml`, as a tag and the repo names or remote addresses it matches: `repoTags: { core-api: ["*-core"] }`. You edit this file by hand.
- The card is what the [connection graph](/features/graph) and the [MCP server](/features/mcp) build on.
