import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationEntry, JavaNavigationSettings } from "@trackwall/protocol";
import { z } from "zod";
import type { Agents } from "../src/modules/agents/agents.ts";
import { makeAgents, viewer, waitFor } from "./support/agents.ts";
import { makeRepo } from "./support/git-repo.ts";

// A session without its own worktree gets the model, the conversation view and Java navigation a task gets (ADR-175),
// but never runs without approvals.

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
  return { jdtls, java: process.execPath, lombok: null, runtimes: [] };
}

function startAgents(settings: () => JavaNavigationSettings | null = () => null) {
  const dir = makeRepo({ "pom.xml": "<project/>\n" }, "shop");
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
  const made = makeAgents({ shop: dir }, undefined, projects, undefined, undefined, undefined, undefined, undefined, settings);
  cleanups.push(() => made.procs.stopAll());
  return { ...made, projects };
}

const PluginManifest = z.object({
  lspServers: z.record(z.string(), z.object({ command: z.string(), args: z.array(z.string()) })).optional(),
});
const pluginManifest = (home: string, session: string) =>
  PluginManifest.parse(JSON.parse(readFileSync(join(home, "sessions", session, "plugin", "plugin.json"), "utf8")));

/** The fake Copilot CLI's screen once it printed its arguments, the last one starting with `last`. */
async function argumentsOf(agents: Agents, session: string, last: string): Promise<string> {
  const window = viewer(agents, session);
  await waitFor(agents, session, () => window.text().includes(`Argument: ${last}`), `${last} on the screen`);
  window.attachment.detach();
  return window.text();
}

/** The conversation the session's conversation socket sends, once it has an answer of the agent. */
async function conversationOf(agents: Agents, session: string): Promise<ConversationEntry[]> {
  let entries: ConversationEntry[] = [];
  const window = agents.attachConversation(session, {
    send: (message) => {
      if (message.reset) entries = [];
      for (const entry of message.entries) {
        const at = entries.findIndex((e) => e.id === entry.id);
        if (at >= 0) entries[at] = entry;
        else entries.push(entry);
      }
    },
    closed: () => {},
  });
  const deadline = Date.now() + 20_000;
  while (!entries.some((e) => e.kind === "agent")) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for the answer: ${JSON.stringify(entries)}`);
    await new Promise((r) => setTimeout(r, 20));
  }
  window.detach();
  return entries;
}

describe.skipIf(process.versions.bun === undefined)(
  "start options of a session without its own worktree (real PTY, fake Copilot CLI)",
  () => {
    test("a repo session runs on the model the user chose, also after a restart, and asks for approvals", async () => {
      const { agents } = startAgents();

      const session = await agents.start("shop", "explain the build", { model: "claude-opus-5.5" });

      const screen = await argumentsOf(agents, session.id, "--session-id=");
      expect(screen).toContain("Argument: --model=claude-opus-5.5");
      expect(screen).not.toContain("--allow-all-tools");
      await waitFor(agents, session.id, (s) => s.state !== null, "sessionStart");
      await agents.restart(session.id);
      expect(await argumentsOf(agents, session.id, "--resume=")).toContain("Argument: --model=claude-opus-5.5");
    }, 60_000);

    test("a free session can run in the conversation view with its prompt as the first message and its model", async () => {
      const { agents } = startAgents();

      const session = await agents.start(null, "compare the two APIs", { model: "gpt-5", view: "conversation" });

      expect(session).toMatchObject({ repo: null, supervisor: false, task: null, view: "conversation" });
      // It asks before the turn's tool, as every session without its own worktree does.
      const asking = await waitFor(agents, session.id, (s) => s.dialog !== null, "the approval request");
      agents.answerDialog(session.id, asking.dialog?.id ?? "", "1");
      const [said, , answer] = await conversationOf(agents, session.id);
      expect(said).toMatchObject({ kind: "user", text: "compare the two APIs" });
      expect(answer?.kind === "agent" && answer.text).toContain("Argument: --model=gpt-5");
    }, 60_000);

    test("a repo session with Java navigation gets jdtls in its own data folder, keeps it across a restart, and closing it deletes the data", async () => {
      const settings = jdtlsSettings();
      const { agents, home, projects } = startAgents(() => settings);

      const session = await agents.start("shop", undefined, { javaNavigation: true });

      const data = join(projects, ".trackwall", "lsp", session.id);
      expect(pluginManifest(home, session.id).lspServers?.java?.args.slice(-2)).toEqual(["-data", join(data, "workspace")]);
      expect(await agents.sessionJavaNavigation(session.id)).toEqual({ kind: "starting" });
      await waitFor(agents, session.id, (s) => s.state !== null, "sessionStart");
      // What jdtls would have written while it indexed the repo.
      mkdirSync(join(data, "workspace"), { recursive: true });

      await agents.restart(session.id);
      expect(pluginManifest(home, session.id).lspServers?.java?.args.slice(-2)).toEqual(["-data", join(data, "workspace")]);
      expect(existsSync(join(data, "workspace"))).toBe(true);

      await agents.stop(session.id);
      await waitFor(agents, session.id, (s) => s.run.kind === "exited", "the end of the session");
      agents.dismiss(session.id);
      // Close answers at once; the folder goes right after it.
      const deadline = Date.now() + 5000;
      while (existsSync(data) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      expect(existsSync(data)).toBe(false);
    }, 60_000);

    test("a repo session without Java navigation gets no jdtls and says nothing of it", async () => {
      const settings = jdtlsSettings();
      const { agents, home } = startAgents(() => settings);

      const session = await agents.start("shop");

      expect(pluginManifest(home, session.id).lspServers).toBeUndefined();
      expect(await agents.sessionJavaNavigation(session.id)).toBeNull();
    }, 60_000);

    test("Java navigation is refused for a free session, in the conversation view and without settings, before anything starts", async () => {
      const settings = jdtlsSettings();
      const { agents } = startAgents(() => settings);

      await expect(agents.start(null, undefined, { javaNavigation: true })).rejects.toMatchObject({
        code: "bad_request",
        message: "Java navigation needs a repo; a free session cannot get it",
      });
      await expect(agents.start("shop", "find the callers", { javaNavigation: true, view: "conversation" })).rejects.toMatchObject({
        code: "bad_request",
      });
      const withoutSettings = startAgents();
      await expect(withoutSettings.agents.start("shop", undefined, { javaNavigation: true })).rejects.toMatchObject({
        code: "bad_request",
        message: "Java navigation cannot start: javaNavigation is not set in workspace.yaml",
      });
      expect(agents.sessions().sessions).toEqual([]);
      expect(withoutSettings.agents.sessions().sessions).toEqual([]);
    }, 60_000);
  },
);
