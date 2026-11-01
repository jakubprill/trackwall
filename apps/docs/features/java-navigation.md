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

Copilot CLI has a built-in `lsp` tool that asks a language server about the code. For Java that server is Eclipse JDT Language Server (jdtls), the engine behind Java in VS Code. Trackwall installs it for you with one button, together with the Java it runs on, Lombok and the Java versions your projects build with, and then starts it for every task that asks for it, in that task's worktree.

On the New session form, a repo with a Maven or Gradle build has the `java` tag on its [repo card](/features/repo-card), and a task in it gets a "Java navigation" pill under the prompt. Turn it on and create the task. Copilot CLI starts jdtls in the background as the session starts, and the agent can use the `lsp` tool while jdtls imports and indexes the project. A resume of the task starts jdtls again with the index it built before.

While Trackwall cannot start jdtls, the pill stays grey: hover it to see why, for example that it is not installed yet or a path in the settings is wrong. The doctor in "Settings > Diagnostics" checks the same once you have set it up.

## Use it

1. Open "Settings", choose "Agents" and click "Install" in the "Java navigation" section. Trackwall downloads jdtls and Lombok into your projects folder and installs Java 25 with [mise](/features/mise-tasks), about 250 MB together, plus, also with mise, each Java version your repos build with, as their repo cards show it (the `java.version` of a `pom.xml`, the toolchain of a Gradle build, a mise `java` tool). The line next to the button shows each step and says "Ready" at the end. Your projects stay on their own Java versions: jdtls gets all of them, so Gradle finds the toolchain a build asks for and an older Gradle runs on a Java it supports.
2. After you add a repo that builds with another Java version, click "Install again". It keeps a Lombok jar and Java installations you named yourself, and also repairs the jdtls folder if something changed it; end the tasks with Java navigation first.
3. Open "Sessions", choose a Java repo on the New session form, turn on "Java navigation" and create the task.

To use a jdtls and Java of your own instead, skip the button and write their full paths into `workspace.yaml`:

```yaml
javaNavigation:
  jdtls: /Users/you/Projects/jdtls
  java: /Users/you/.local/share/mise/installs/java/25/bin/java
  lombok: /Users/you/Projects/lombok.jar
  runtimes:
    - /Users/you/.local/share/mise/installs/java/17
    - /Library/Java/JavaVirtualMachines/zulu-8.jdk/Contents/Home
```

`lombok` and `runtimes` are optional. Each entry of `runtimes` is the folder of a Java installation, the one with the `release` file in it.

## Good to know

- Only agent tasks get it, not main sessions, free sessions, the supervisor or tasks started from a proposal.
- The first start of a task indexes the whole project: about a minute for a Spring Boot service, and up to 2 GB of memory per task while it runs. Several tasks with navigation at once each run their own jdtls.
- jdtls imports the project with Maven or Gradle and downloads its dependencies, as your IDE does. While the task's session runs, its header says how far jdtls is: starting, importing, ready, or that the import failed or stalled, with jdtls's error in the tooltip. Until it says ready, the agent's questions come back empty; after a failed import, for example because Gradle needs a Java version that is not installed, they stay empty. Run `/lsp logs` in the session for the details.
- A project with both a `pom.xml` and a Gradle build is imported with Maven, which needs nothing beyond the Java jdtls runs on.
- Every path in `javaNavigation` must be a full path. A path that is not there greys the pill out until you fix it or click "Install again"; a resumed task then starts without navigation.
- When mise cannot install one of your projects' Java versions, for example Java 8, which has no Temurin build for Apple silicon, the line next to the button says so in yellow. Navigation works in the other repos; for that one, add the folder of a Java installation of that version under `runtimes`.
- jdtls loads Lombok in every task, so code that uses Lombok's getters, builders and loggers resolves; a project without Lombok does not notice it.
- The install needs mise and access to download.eclipse.org, repo1.maven.org (Lombok) and the place mise downloads Java from. Trackwall checks the jdtls and Lombok downloads against the checksums of the releases it was built with, so a newer jdtls or Lombok comes with a newer Trackwall.
- The index of each task lives in `.trackwall/lsp` in your projects folder and is deleted when you end the task.
- jdtls on Windows starts without Python: Trackwall runs it with `java` directly.
