import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JavaNavigationSettings } from "@trackwall/protocol";
import { z } from "zod";
import { DomainError } from "../src/infra/errors.ts";
import type { Agents } from "../src/modules/agents/agents.ts";
import { makeAgents, viewer, waitFor } from "./support/agents.ts";
import { makeRepo } from "./support/git-repo.ts";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** A jdtls folder as its release archive unpacks, with this test's own program standing in for `java`. */
function jdtlsSettings(): JavaNavigationSettings {
  const jdtls = mkdtempSync(join(tmpdir(), "trackwall-jdtls-"));
  mkdirSync(join(jdtls, "plugins"));
  writeFileSync(join(jdtls, "plugins", "org.eclipse.equinox.launcher_1.7.100.jar"), "");
  for (const config of ["config_win", "config_mac", "config_mac_arm", "config_linux", "config_linux_arm"]) mkdirSync(join(jdtls, config));
  return { jdtls, java: process.execPath, lombok: null };
}

/** Agents for repo `shop` in `dir` whose workspace has `javaNavigation` as `settings` returns it at that moment. */
function agentsWithJavaNavigation(dir: string, projects: string | null, settings: () => JavaNavigationSettings | null) {
  return makeAgents({ shop: dir }, undefined, projects, undefined, undefined, undefined, undefined, undefined, settings);
}

function sessionOf(agents: Agents, task: string): string {
  const [session, ...more] = agents.sessions().sessions.filter((s) => s.task === task);
  if (!session || more.length > 0) throw new Error(`task ${task} does not have exactly one session`);
  return session.id;
}

/** The session plugin's manifest, which carries the language servers to Copilot CLI. */
const PluginManifest = z.object({
  lspServers: z
    .record(
      z.string(),
      z.object({
        command: z.string(),
        args: z.array(z.string()),
        fileExtensions: z.record(z.string(), z.string()),
        initializationOptions: z.unknown().optional(),
      }),
    )
    .optional(),
});
const pluginManifest = (home: string, session: string) =>
  PluginManifest.parse(JSON.parse(readFileSync(join(home, "sessions", session, "plugin", "plugin.json"), "utf8")));

describe.skipIf(process.versions.bun === undefined)("Java navigation for tasks (real git and PTY, fake Copilot CLI)", () => {
  test("a task with Java navigation gets jdtls in its session plugin with its own data folder, and a task without it gets none", async () => {
    const dir = makeRepo({ "pom.xml": "<project/>\n" }, "shop");
    const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
    const settings = jdtlsSettings();
    const { agents, procs, home } = agentsWithJavaNavigation(dir, projects, () => settings);
    cleanups.push(() => procs.stopAll());
    expect(agents.startOptions()).toEqual({ javaNavigation: { problem: null } });

    const task = await agents.createTask("shop", "find the callers of OrderService", "ask", null, true);
    expect(task.javaNavigation).toBe(true);
    const session = sessionOf(agents, task.id);
    const java = pluginManifest(home, session).lspServers?.java;
    expect(Object.keys(pluginManifest(home, session).lspServers ?? {})).toEqual(["java"]);
    expect(java?.command).toBe(process.execPath);
    expect(java?.fileExtensions).toEqual({ ".java": "java" });
    expect(java?.args.slice(-2)).toEqual(["-data", join(projects, ".trackwall-lsp", task.id, "workspace")]);
    const window = viewer(agents, session);
    await waitFor(agents, session, () => window.text().includes("LSP: java"), "the language server on the screen");
    window.attachment.detach();

    const plain = await agents.createTask("shop", "update the README");
    expect(plain.javaNavigation).toBe(false);
    expect(pluginManifest(home, sessionOf(agents, plain.id)).lspServers).toBeUndefined();
  }, 60_000);

  test("without the settings a task with Java navigation is refused before its worktree exists, and the form learns why", async () => {
    const dir = makeRepo({ "pom.xml": "<project/>\n" }, "shop");
    const { agents, procs } = makeAgents({ shop: dir }, undefined, mkdtempSync(join(tmpdir(), "trackwall-projects-")));
    cleanups.push(() => procs.stopAll());
    expect(agents.startOptions()).toEqual({ javaNavigation: null });

    await expect(agents.createTask("shop", "find the callers", "ask", null, true)).rejects.toMatchObject({
      code: "bad_request",
      message: "Java navigation cannot start: javaNavigation is not set in workspace.yaml",
    });
    expect(agents.sessions().tasks).toEqual([]);

    const broken = { ...jdtlsSettings(), java: join(tmpdir(), "no-such-java") };
    const withBroken = agentsWithJavaNavigation(dir, null, () => broken);
    cleanups.push(() => withBroken.procs.stopAll());
    expect(withBroken.agents.startOptions()).toEqual({ javaNavigation: { problem: `no Java program at ${broken.java}` } });
  }, 60_000);

  test("a bad javaNavigation key greys the option out with its message, and a resume of a task with navigation still starts, without jdtls", async () => {
    const dir = makeRepo({ "pom.xml": "<project/>\n" }, "shop");
    const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
    let bad = false;
    const settings = jdtlsSettings();
    const { agents, procs, home } = agentsWithJavaNavigation(dir, projects, () => {
      if (bad) throw new DomainError("invalid_config", "workspace.yaml: javaNavigation: jdtls, java and lombok must be full paths");
      return settings;
    });
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("shop", "find the callers", "ask", null, true);
    const first = sessionOf(agents, task.id);
    await waitFor(agents, first, (s) => s.state !== null, "the task prompt's sessionStart");
    await agents.stop(first);

    bad = true;
    expect(agents.startOptions()).toEqual({
      javaNavigation: { problem: "workspace.yaml: javaNavigation: jdtls, java and lombok must be full paths" },
    });
    await agents.resumeTask(task.id);
    expect(pluginManifest(home, sessionOf(agents, task.id)).lspServers).toBeUndefined();
  }, 60_000);

  test("a resume after the settings are gone starts without jdtls, and ending the task deletes its jdtls data", async () => {
    const dir = makeRepo({ "pom.xml": "<project/>\n" }, "shop");
    const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
    let settings: JavaNavigationSettings | null = jdtlsSettings();
    const { agents, procs, home } = agentsWithJavaNavigation(dir, projects, () => settings);
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("shop", "find the callers", "ask", null, true);
    const first = sessionOf(agents, task.id);
    await waitFor(agents, first, (s) => s.state !== null, "the task prompt's sessionStart");
    await agents.stop(first);
    // What jdtls would have written while it indexed the worktree.
    const data = join(projects, ".trackwall-lsp", task.id);
    mkdirSync(join(data, "workspace"), { recursive: true });

    settings = null;
    await agents.resumeTask(task.id);
    const resumed = sessionOf(agents, task.id);
    expect(pluginManifest(home, resumed).lspServers).toBeUndefined();
    expect(agents.task(task.id).javaNavigation).toBe(true);

    await agents.stop(resumed);
    await agents.removeTask(task.id, false, true);
    expect(existsSync(data)).toBe(false);
  }, 60_000);

  test("a repo with both a pom.xml and a Gradle build gets jdtls set to import with Maven only (ADR-124)", async () => {
    const dir = makeRepo({ "pom.xml": "<project/>\n", "build.gradle": "plugins { id 'java' }\n" }, "shop");
    const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
    const settings = jdtlsSettings();
    const { agents, procs, home } = agentsWithJavaNavigation(dir, projects, () => settings);
    cleanups.push(() => procs.stopAll());

    const task = await agents.createTask("shop", "find the callers", "ask", null, true);
    expect(pluginManifest(home, sessionOf(agents, task.id)).lspServers?.java?.initializationOptions).toEqual({
      settings: { java: { import: { gradle: { enabled: false } } } },
    });
  }, 60_000);

  test("the task says how its jdtls is doing from the log in its data folder, and a task without navigation says nothing (ADR-124)", async () => {
    const dir = makeRepo({ "pom.xml": "<project/>\n" }, "shop");
    const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
    const settings = jdtlsSettings();
    const { agents, procs } = agentsWithJavaNavigation(dir, projects, () => settings);
    cleanups.push(() => procs.stopAll());
    const task = await agents.createTask("shop", "find the callers", "ask", null, true);
    expect(await agents.taskJavaNavigation(task.id)).toEqual({ kind: "starting" });

    const metadata = join(projects, ".trackwall-lsp", task.id, "workspace", ".metadata");
    mkdirSync(metadata, { recursive: true });
    writeFileSync(
      join(metadata, ".log"),
      [
        "!SESSION 2026-10-29 10:00:00.000 -----------------------------------------------",
        "!ENTRY org.eclipse.buildship.core 4 0 2026-10-29 10:00:40.000",
        "!MESSAGE Synchronize project shop failed due to an error connecting to the Gradle build.",
      ].join("\n"),
    );
    expect(await agents.taskJavaNavigation(task.id)).toEqual({
      kind: "failed",
      message: "Synchronize project shop failed due to an error connecting to the Gradle build.",
    });

    const plain = await agents.createTask("shop", "update the README");
    expect(await agents.taskJavaNavigation(plain.id)).toBeNull();
  }, 60_000);
});
