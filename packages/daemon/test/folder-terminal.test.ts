import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ApiEnvelope, agentsApi, PTY_CLOSE_NOT_FOUND, TERMINAL_SUBPROTOCOL, terminalsApi } from "@trackwall/protocol";
import WebSocket from "ws";
import { loopbackRequest } from "../src/infra/loopback.ts";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "t".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN, { repos: { shop: { "README.md": "# shop\n" }, billing: {} }, miseCommand: ["mise"] });
}, SLOW_TEST_TIMEOUT_MS);

afterAll(() => daemon.stop());

/** The command that prints the shell's working directory: `cd` alone in `cmd.exe`, `pwd` elsewhere. */
const PRINT_FOLDER = process.platform === "win32" ? "cd\r" : "pwd\r";

/** A terminal window: collects the screen image and output as text. */
function connect(terminal: string, protocols = [TERMINAL_SUBPROTOCOL, `bearer.${TOKEN}`]) {
  const ws = new WebSocket(`ws://127.0.0.1:${daemon.api.port}/ws/terminal/${terminal}`, protocols);
  let text = "";
  ws.on("message", (data: Buffer) => {
    text += data.toString("utf8");
  });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`status ${res.statusCode}`)));
  });
  const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
  return { ws, opened, closed, text: () => text };
}

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** An action's error code, for an action that must fail. */
async function errorOf(path: string, body: unknown): Promise<string> {
  const res = await loopbackRequest(daemon.api.port, path, { method: "POST", token: TOKEN, body: JSON.stringify(body), timeoutMs: 10_000 });
  const result = ApiEnvelope.parse(JSON.parse(res.body));
  if (result.ok) throw new Error(`${path} succeeded`);
  return result.error.code;
}

/** The folder as the shell prints it: macOS's temp folder is behind a link. */
function printed(folder: string): string {
  return realpathSync(folder).split(/[\\/]/).at(-1) ?? folder;
}

describe.skipIf(process.versions.bun === undefined)("a folder terminal (real PTY, the user's shell)", () => {
  test("the shell starts in the repo root, takes keys, and a second window starts from the same screen", async () => {
    const terminal = await daemon.post(terminalsApi.start, { repo: "shop", task: null });
    expect(terminal).toMatchObject({ repo: "shop", task: null, run: { kind: "running" } });

    const first = connect(terminal.id);
    await first.opened;
    expect(first.ws.protocol).toBe(TERMINAL_SUBPROTOCOL);
    first.ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
    first.ws.send(JSON.stringify({ type: "input", data: PRINT_FOLDER }));
    await until(() => first.text().includes(printed(join(daemon.projects, "shop"))), "the repo folder printed by the shell");

    const second = connect(terminal.id);
    await second.opened;
    await until(() => second.text().includes(printed(join(daemon.projects, "shop"))), "the screen image in a second window");

    first.ws.close();
    second.ws.close();
    await daemon.post(terminalsApi.close, { terminal: terminal.id });
  }, 60_000);

  test("the projects folder has a shell of its own, beside the shell of a repo in it", async () => {
    const repoShell = await daemon.post(terminalsApi.start, { repo: "shop", task: null });
    const terminal = await daemon.post(terminalsApi.start, { repo: null, task: null });
    expect(terminal).toMatchObject({ repo: null, task: null, run: { kind: "running" } });
    expect(terminal.id).not.toBe(repoShell.id);

    const window = connect(terminal.id);
    await window.opened;
    window.ws.send(JSON.stringify({ type: "input", data: PRINT_FOLDER }));
    await until(() => window.text().includes(printed(daemon.projects)), "the projects folder printed by the shell");
    expect((await daemon.post(terminalsApi.start, { repo: null, task: null })).id).toBe(terminal.id);

    window.ws.close();
    await daemon.post(terminalsApi.close, { terminal: terminal.id });
    await daemon.post(terminalsApi.close, { terminal: repoShell.id });
  }, 60_000);

  test("opening the terminal of a place again hands back the live one, also when asked twice at once", async () => {
    const [a, b] = await Promise.all([
      daemon.post(terminalsApi.start, { repo: "billing", task: null }),
      daemon.post(terminalsApi.start, { repo: "billing", task: null }),
    ]);
    expect(b.id).toBe(a.id);
    expect((await daemon.post(terminalsApi.list, {})).filter((t) => t.repo === "billing")).toHaveLength(1);
    await daemon.post(terminalsApi.close, { terminal: a.id });
  }, 60_000);

  test("closing ends the shell, closes its windows and forgets it", async () => {
    const terminal = await daemon.post(terminalsApi.start, { repo: "shop", task: null });
    const window = connect(terminal.id);
    await window.opened;

    await daemon.post(terminalsApi.close, { terminal: terminal.id });

    expect(await window.closed).toBe(PTY_CLOSE_NOT_FOUND);
    expect(await daemon.post(terminalsApi.list, {})).toEqual([]);
    expect(daemon.facade.procs.liveIn(join(daemon.projects, "shop"))).toBe(false);
    expect(await connect(terminal.id).closed).toBe(PTY_CLOSE_NOT_FOUND);
  }, 60_000);

  test("a shell that ends by itself stays listed as ended, and opening the place again starts a new shell in it", async () => {
    const terminal = await daemon.post(terminalsApi.start, { repo: "shop", task: null });
    const window = connect(terminal.id);
    await window.opened;
    window.ws.send(JSON.stringify({ type: "input", data: "exit\r" }));
    await until(async () => (await daemon.post(terminalsApi.list, {}))[0]?.run.kind === "exited", "the ended shell in the list");

    const again = await daemon.post(terminalsApi.start, { repo: "shop", task: null });

    expect(again).toMatchObject({ id: terminal.id, run: { kind: "running" } });
    window.ws.close();
    await daemon.post(terminalsApi.close, { terminal: terminal.id });
  }, 60_000);

  test("a task's terminal starts in its worktree, and ending the task closes it", async () => {
    const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "change nothing", approvals: "ask" });
    const terminal = await daemon.post(terminalsApi.start, { repo: "shop", task: task.id });
    const window = connect(terminal.id);
    await window.opened;
    window.ws.send(JSON.stringify({ type: "input", data: PRINT_FOLDER }));
    await until(() => window.text().includes(printed(task.worktree)), "the worktree printed by the shell");

    const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task.id && s.run.kind === "running");
    if (session) await daemon.facade.agents.stop(session.id);
    await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });

    expect(await window.closed).toBe(PTY_CLOSE_NOT_FOUND);
    expect(await daemon.post(terminalsApi.list, {})).toEqual([]);
  }, 60_000);

  test("an end of a task that is refused leaves its shell running", async () => {
    const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "change nothing", approvals: "ask" });
    const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task.id && s.run.kind === "running");
    if (session) await daemon.facade.agents.stop(session.id);
    writeFileSync(join(task.worktree, "notes.txt"), "not committed\n");
    const terminal = await daemon.post(terminalsApi.start, { repo: "shop", task: task.id });

    expect(await errorOf(agentsApi.removeTask.path, { task: task.id, keepBranch: false, discardChanges: false })).toBe("unsaved_changes");

    expect(await daemon.post(terminalsApi.list, {})).toEqual([
      expect.objectContaining({ id: terminal.id, run: expect.objectContaining({ kind: "running" }) }),
    ]);
    await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
    expect(await daemon.post(terminalsApi.list, {})).toEqual([]);
  }, 60_000);

  test("a place that is not there, a task of another repo, or a task without its repo, opens nothing", async () => {
    const task = await daemon.post(agentsApi.createTask, { repo: "shop", prompt: "change nothing", approvals: "ask" });

    expect(await errorOf(terminalsApi.start.path, { repo: "nowhere", task: null })).toBe("not_found");
    expect(await errorOf(terminalsApi.start.path, { repo: "shop", task: "00000000-0000-4000-8000-000000000000" })).toBe("not_found");
    expect(await errorOf(terminalsApi.start.path, { repo: "billing", task: task.id })).toBe("bad_request");
    expect(await errorOf(terminalsApi.start.path, { repo: "shop", task: null, cwd: "/" })).toBe("bad_request");
    expect(await errorOf(terminalsApi.start.path, { repo: null, task: task.id })).toBe("bad_request");
    expect(await daemon.post(terminalsApi.list, {})).toEqual([]);

    const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task.id && s.run.kind === "running");
    if (session) await daemon.facade.agents.stop(session.id);
    await daemon.post(agentsApi.removeTask, { task: task.id, keepBranch: false, discardChanges: true });
  }, 60_000);

  test("without the token the terminal's socket is refused", async () => {
    const terminal = "00000000-0000-4000-8000-000000000000";
    await expect(connect(terminal, [TERMINAL_SUBPROTOCOL]).opened).rejects.toThrow("status 401");
    await expect(connect(terminal, [`bearer.${TOKEN}`]).opened).rejects.toThrow("status 400");
    expect(await connect("not-a-uuid").closed).toBe(PTY_CLOSE_NOT_FOUND);
  });
});
