---
title: Java navigation
description: Give an agent task in a Java repo a language server, so it finds definitions, usages and implementations instead of searching text.
---

# Java navigation

Give an agent task in a Java repo a language server, so it finds definitions, usages and implementations instead of searching text.

## What you get

- The agent of an [agent task](/features/tasks) in a Java repo jumps to a class's definition and lists every place that uses it.
- It finds implementations of an interface, callers of a method and symbols by name, the way your IDE does.
- Each task gets its own language server on its own worktree, so tasks never see each other's half-done changes.
- You turn it on per task with one pill, and the New session form remembers your choice for the repo.

## How it works

Copilot CLI has a built-in `lsp` tool that asks a language server about the code. For Java that server is Eclipse JDT Language Server (jdtls), the engine behind Java in VS Code. You install it once and tell Trackwall where it is; Trackwall then starts it for every task that asks for it, in that task's worktree.

On the New session form, a repo with a Maven or Gradle build has the `java` tag on its [repo card](/features/repo-card), and a task in it gets a "Java navigation" pill under the prompt. Turn it on and create the task. Copilot CLI starts jdtls in the background as the session starts, and the agent can use the `lsp` tool while jdtls imports and indexes the project. A resume of the task starts jdtls again with the index it built before.

While Trackwall cannot start jdtls, the pill stays grey: hover it to see why, for example that the settings are missing or a path in them is wrong.

## Use it

1. Download a jdtls release from the [Eclipse download site](https://download.eclipse.org/jdtls/snapshots/) and unpack it into a folder, for example in your projects folder.
2. Install the Java version that jdtls needs to run (Java 25 for current releases), for example with `mise use -g java@25`. Your projects can stay on their own Java versions.
3. Add the paths to `~/.trackwall/workspace.yaml`:

   ```yaml
   javaNavigation:
     jdtls: /Users/you/Projects/jdtls
     java: /Users/you/.local/share/mise/installs/java/25/bin/java
   ```

4. If your projects use Lombok, add `lombok: /full/path/to/lombok.jar` under `javaNavigation`, so jdtls understands the generated getters.
5. Open "Sessions", choose a Java repo on the New session form, turn on "Java navigation" and create the task.

## Good to know

- Only agent tasks get it, not main sessions, free sessions, the supervisor or tasks started from a proposal.
- The first start of a task indexes the whole project: about a minute for a Spring Boot service, and up to 2 GB of memory per task while it runs. Several tasks with navigation at once each run their own jdtls.
- jdtls imports the project with Maven or Gradle and downloads its dependencies, as your IDE does. If the import fails, for example because Gradle needs a Java version you have not installed, the agent's questions come back empty. Run `/lsp logs` in the session to see why.
- Every path in `javaNavigation` must be a full path. A path that is not there greys the pill out until you fix it; a resumed task then starts without navigation.
- The index of each task lives in `.trackwall/lsp` in your projects folder and is deleted when you end the task.
- jdtls on Windows starts without Python: Trackwall runs it with `java` directly.
