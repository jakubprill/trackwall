import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { agentsApi, workspaceApi } from "@trackwall/protocol";
import { sessionHooksFile } from "../src/modules/agents/session-launcher.ts";
import { viewer, waitFor } from "./support/agents.ts";
import { PARALLEL_TOOLS_PROMPT } from "./support/copilot-reference.ts";
import { untilInputBox } from "./support/screen-lines.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

// "Always allow" in a task's approval (ADR-249) through the API the tray panel and Home call: the tool goes into
// `workspace.yaml` for the repo, the running task's later approvals of it are answered by the daemon, the next task
// starts with `--allow-tool` and is not asked, and removing it in Settings asks again.

const TOKEN = "w".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(() => daemon.stop(), 30_000);

function runningSessionOf(task: string): string {
  const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task && s.run.kind === "running");
  if (!session) throw new Error(`task ${task} has no running session`);
  return session.id;
}

/** Types `prompt` into session `session` once its input box is there; the fake Copilot CLI then runs its command. */
async function typePrompt(session: string, prompt: string): Promise<void> {
  const window = viewer(daemon.facade.agents, session);
  await untilInputBox(window, "empty");
  window.attachment.input(`${prompt}\r`);
  window.attachment.detach();
}

/** A new task in `shop` asking for approvals, whose turn runs the reference's command; its running session. */
async function taskAsking(prompt: string): Promise<string> {
  const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt, approvals: "ask" });
  const session = runningSessionOf(task.id);
  await typePrompt(session, prompt);
  return session;
}

/** The arguments the fake Copilot CLI printed for `session`. */
async function argumentsOf(session: string): Promise<string[]> {
  const window = viewer(daemon.facade.agents, session);
  await waitFor(daemon.facade.agents, session, () => window.text().includes("Argument: --session-id="), "the arguments on the screen");
  window.attachment.detach();
  return window
    .text()
    .split(/\r?\n/)
    .filter((line) => line.startsWith("Argument: "))
    .map((line) => line.slice("Argument: ".length).trim());
}

/** The hook events session `session` sent so far, in order. */
const hookEvents = (session: string) =>
  readFileSync(sessionHooksFile(daemon.home, session), "utf8")
    .split("\n")
    .flatMap((line) => /"event":"(\w+)"/.exec(line)?.[1] ?? []);
const endedTurns = (session: string) => hookEvents(session).filter((e) => e === "agentStop").length;

describe.skipIf(process.versions.bun === undefined)("Always allow in a task's approval (real PTY and git, fake Copilot CLI)", () => {
  test(
    "the tool is remembered for the repo, the running task and the next task are not asked again, and Settings takes it back",
    async () => {
      const { agents } = daemon.facade;
      // Two commands at once: Copilot CLI asks about the second right after the answer to the first.
      const first = await taskAsking(PARALLEL_TOOLS_PROMPT);
      const asking = await waitFor(agents, first, (s) => s.dialog?.kind === "approval", "the approval dialog");
      if (asking.dialog?.kind !== "approval") throw new Error("no approval dialog");
      if (process.platform === "win32") {
        // A PowerShell command has no "don't ask again" in Copilot CLI, so there is nothing to remember.
        expect(asking.dialog.alwaysAllow).toBeUndefined();
        await daemon.post(agentsApi.stop, { session: first });
        return;
      }
      expect(asking.dialog.alwaysAllow).toBe("shell(touch)");

      await daemon.post(agentsApi.alwaysAllowDialog, { session: first, dialog: asking.dialog.id });

      expect((await daemon.post(workspaceApi.settings, {})).alwaysAllow).toEqual([{ repo: "shop", tool: "shell(touch)" }]);
      expect(readFileSync(join(daemon.home, "workspace.yaml"), "utf8")).toContain("alwaysAllow:\n  - repo: shop\n    tool: shell(touch)\n");
      // The running task started without the permission, so Copilot CLI asks about the second command, and the daemon
      // answers it: the turn ends without another answer from the test.
      const ended = await waitFor(agents, first, () => endedTurns(first) === 1, "the end of the turn without a second answer");
      expect(ended.dialog).toBeNull();
      await daemon.post(agentsApi.stop, { session: first });

      // The next task of the repo starts with the permission and runs the command without a dialog.
      const next = await taskAsking("make a file too");
      expect(await argumentsOf(next)).toContain("--allow-tool=shell(touch)");
      await waitFor(agents, next, () => endedTurns(next) === 1, "the next task's turn without a dialog");
      expect(hookEvents(next)).not.toContain("notification");
      await daemon.post(agentsApi.stop, { session: next });

      const removed = await daemon.post(workspaceApi.removeAlwaysAllowed, { repo: "shop", tool: "shell(touch)" });
      expect(removed.alwaysAllow).toEqual([]);
      const last = await taskAsking("make one more file");
      expect(await argumentsOf(last)).not.toContain("--allow-tool=shell(touch)");
      await waitFor(agents, last, (s) => s.dialog?.kind === "approval", "the approval dialog again");
      await daemon.post(agentsApi.stop, { session: last });
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test("Always allow in a session in the repo root is refused, since only a task offers it", async () => {
    const session = await daemon.post(agentsApi.start, { repo: "shop" });

    await expect(daemon.post(agentsApi.alwaysAllowDialog, { session: session.id, dialog: "0123456789abcdef" })).rejects.toThrow(
      /only in a task/,
    );
    await daemon.post(agentsApi.stop, { session: session.id });
  }, 60_000);
});
