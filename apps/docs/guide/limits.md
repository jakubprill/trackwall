---
title: Limits today
description: What Trackwall does not do yet, which stacks and systems it knows, and where its picture of your repos stops.
---

# Limits today

What Trackwall does not do yet, which stacks and systems it knows, and where its picture of your repos stops.

Trackwall is at an early stage. This page lists what it does not cover, so you can tell a missing feature from a bug.

## Agents

- **Copilot CLI only.** Sessions, tasks and the supervisor run Copilot CLI. Another agent can use Trackwall's tools through the [MCP server](/features/mcp), but it gets no session, state or approvals in the app.
- **Session states come partly from the screen.** Trackwall reads Copilot CLI's approval questions from its terminal, so a new Copilot CLI version that changes those screens can break them until Trackwall follows. Trackwall checks its assumptions against the newest Copilot CLI every night.
- **The conversation view is a preview.** "Chat (preview)" covers the supervisor and tasks; [Java navigation](/features/java-navigation) works only in the terminal.
- **No time or cost budget per task.** A task runs until it ends, you stop it, or its agent stops.

## Your repos

- **What the card reads.** Build files of Maven, Gradle and npm; Spring Boot apps with their configuration; HTTP endpoints and clients in Java and Kotlin code and OpenAPI specs; frontend dev proxies. Other stacks get their tools and mise tasks, but no packages, endpoints or calls. See [Repo card](/features/repo-card).
- **Only the last commit.** The card, the graph and code search read committed files, so a change you have not committed yet is not in them.
- **Calls over HTTP and packages only.** Messaging (Kafka topics, queues) and calls through configuration that is only in your deployment do not show in the graph; add those connections by hand. See [Connection graph](/features/graph).
- **No description from a model.** The card has facts from files, without a summary written by an AI.

## Logs and services

- **Logs of mise tasks and services only.** The logs of a session, of the daemon itself, or of a service you started outside Trackwall are not collected, and there is no search across all logs or tracing of one request through several services.
- **A service is a `dev` mise task.** A repo without one cannot be started from "Services".
- **Masking knows the secrets Trackwall gives.** A secret a program reads by itself, from a `.env` file or a password manager, is not masked in its log. See [Security model](/guide/security-model).

## Systems and setup

- **Windows and macOS** for the desktop app. On Linux, Trackwall runs in a [dev container](/guide/dev-container) and you use it from a browser or the desktop app on your computer.
- **One person, one computer.** There is no shared server or team view; each person runs their own Trackwall.
- **Some settings are a file.** `workspace.yaml` holds rules you edit by hand, such as tool permissions, tags and manual connections. Connecting your own Copilot CLI to Trackwall is a command you copy from "Settings".
