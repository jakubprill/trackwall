import { afterEach, describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { type FolderTerminal, TERMINAL_SUBPROTOCOL, terminalsApi } from "@trackwall/protocol";
import WebSocket from "ws";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

// A daemon restart (an update, the app's exit, a container or computer restart) ends every shell with its process
// group; the next daemon opens a new shell in each place where one ran (§4.23), the way it resumes the agents' sessions.

const TOKEN = "f".repeat(43);
const REPOS = { shop: { "README.md": "# shop\n" }, billing: {} };
const daemons: Awaited<ReturnType<typeof startSessionApi>>[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
}, SLOW_TEST_TIMEOUT_MS);

async function startDaemon(restartOf?: { home: string; projects: string }) {
  const daemon = await startSessionApi(TOKEN, { repos: REPOS, miseCommand: ["mise"], restartOf });
  daemons.push(daemon);
  return daemon;
}

/** Stops the daemon as its exit does. */
async function stopDaemon(daemon: Awaited<ReturnType<typeof startSessionApi>>) {
  daemons.splice(daemons.indexOf(daemon), 1);
  await daemon.stop();
}

/** The command that prints the shell's working directory: `cd` alone in `cmd.exe`, `pwd` elsewhere. */
const PRINT_FOLDER = process.platform === "win32" ? "cd\r" : "pwd\r";

async function until(check: () => boolean | Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** The running shells by place, as the UI lists them. */
async function runningPlaces(daemon: Awaited<ReturnType<typeof startSessionApi>>): Promise<{ repo: string | null; task: string | null }[]> {
  const list: FolderTerminal[] = await daemon.post(terminalsApi.list, {});
  return list
    .filter((t) => t.run.kind === "running")
    .map(({ repo, task }) => ({ repo, task }))
    .sort((a, b) => String(a.repo).localeCompare(String(b.repo)));
}

/** What a window of the terminal shows after typing `input`, once the text has `expected`. */
async function screenAfter(daemon: Awaited<ReturnType<typeof startSessionApi>>, terminal: string, input: string, expected: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${daemon.api.port}/ws/terminal/${terminal}`, [TERMINAL_SUBPROTOCOL, `bearer.${TOKEN}`]);
  let text = "";
  ws.on("message", (data: Buffer) => {
    text += data.toString("utf8");
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "input", data: input }));
  try {
    await until(() => text.includes(expected), expected);
    return text;
  } finally {
    ws.close();
  }
}

/** The folder as the shell prints it: macOS's temp folder is behind a link. */
function printed(folder: string): string {
  return realpathSync(folder).split(/[\\/]/).at(-1) ?? folder;
}

describe.skipIf(process.versions.bun === undefined)("folder terminals across a daemon restart (real PTY, the user's shell)", () => {
  test(
    "the shells that ran when the daemon stopped open again in the same places, each saying it is a new shell",
    async () => {
      const first = await startDaemon();
      await first.post(terminalsApi.start, { repo: "shop", task: null });
      await first.post(terminalsApi.start, { repo: null, task: null });
      await stopDaemon(first);

      const next = await startDaemon({ home: first.home, projects: first.projects });

      await until(async () => (await runningPlaces(next)).length === 2, "two shells open again");
      expect(await runningPlaces(next)).toEqual([
        { repo: null, task: null },
        { repo: "shop", task: null },
      ]);
      const shop = (await next.post(terminalsApi.list, {})).find((t) => t.repo === "shop");
      if (!shop) throw new Error("the shop shell is not listed");
      const screen = await screenAfter(next, shop.id, PRINT_FOLDER, printed(join(next.projects, "shop")));
      expect(screen).toContain("Trackwall restarted");
    },
    SLOW_TEST_TIMEOUT_MS,
  );

  test(
    "a shell the user closed, or one that ended by itself, does not come back",
    async () => {
      const first = await startDaemon();
      const closed = await first.post(terminalsApi.start, { repo: "shop", task: null });
      await first.post(terminalsApi.close, { terminal: closed.id });
      const exited = await first.post(terminalsApi.start, { repo: "billing", task: null });
      await screenAfter(first, exited.id, "exit\r", "exit");
      await until(async () => (await runningPlaces(first)).length === 0, "the shell ended by itself");
      await stopDaemon(first);

      const next = await startDaemon({ home: first.home, projects: first.projects });
      // The reopening runs in the background after the API listens; give it the time a start takes.
      await new Promise((r) => setTimeout(r, 1_000));

      expect(await next.post(terminalsApi.list, {})).toEqual([]);
    },
    SLOW_TEST_TIMEOUT_MS,
  );
});
