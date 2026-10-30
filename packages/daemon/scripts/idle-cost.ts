/**
 * How much the daemon does while nothing happens: the demo's twenty repos and a session in each repo of the demo turns,
 * left alone for a while, first with nobody listening to `/ws` events and then with one listener, as a window keeps.
 * Prints the CPU time of the daemon process and how often the hot reads ran in each phase and how long they took, so a
 * change to the read cycles can be compared with a number instead of a guess, and the cycles' share of the CPU time shows.
 * Last, rounds of repo statuses as the views refresh them, with the git processes each started (ADR-141).
 *
 *   bun packages/daemon/scripts/idle-cost.ts [seconds per phase]
 *
 * Copilot CLI is the demo's stand-in (`scripts/demo/copilot.ts`), so nothing reaches a model; mise is not needed.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EVENTS_SOCKET, SOCKET_TOKEN_PREFIX } from "@trackwall/protocol";
import { EventHub } from "../src/api/event-hub.ts";
import { sessionHookRequest } from "../src/api/hooks.ts";
import { startApi } from "../src/api/server.ts";
import { createFacade, HOSTING_CLIS } from "../src/facade.ts";
import { newToken } from "../src/infra/discovery.ts";
import { removeFolder, removeIfPresent } from "../src/infra/remove-folder.ts";
import { SHUTDOWN_SIGNALS, shutdownOnce, stopDaemon } from "../src/infra/shutdown.ts";
import { userEnv } from "../src/infra/user-env.ts";
import { createMcpEndpoint, sessionMcpRequest } from "../src/mcp/endpoint.ts";
import { LiveSession } from "../src/modules/agents/live-session.ts";
import { TerminalScreen } from "../src/modules/agents/terminal-screen.ts";
import { gitProcessesStarted } from "../src/modules/vcs/git.ts";
import { TURNS } from "./demo/turns.ts";
import { createDemoWorkspace } from "./demo/workspace.ts";

const seconds = Number(process.argv[2] ?? "20");
if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("usage: bun scripts/idle-cost.ts [seconds per phase > 0]");
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const home = mkdtempSync(join(tmpdir(), "trackwall-idle-"));
const projectsDir = join(home, "projects");
createDemoWorkspace(projectsDir);
writeFileSync(join(home, "workspace.yaml"), `projectsDir: ${JSON.stringify(projectsDir)}\n`);

/** Counts calls of a method on a prototype and the time they took, for the phase report. */
const counts = new Map<string, { calls: number; ms: number }>();
function count<T extends object>(proto: T, name: keyof T & string, label: string): void {
  const original = proto[name];
  if (typeof original !== "function") throw new Error(`${label} is not a method`);
  Object.defineProperty(proto, name, {
    value(this: unknown, ...args: unknown[]) {
      const started = performance.now();
      try {
        return original.apply(this, args);
      } finally {
        const counted = counts.get(label) ?? { calls: 0, ms: 0 };
        counts.set(label, { calls: counted.calls + 1, ms: counted.ms + performance.now() - started });
      }
    },
  });
}
count(TerminalScreen.prototype, "lines", "screen lines() parses");
count(LiveSession.prototype, "tick", "session cycles (LiveSession.tick)");

const token = newToken();
const facade = createFacade({
  home,
  homeFrom: "flag",
  openUrl: () => {},
  openFolder: () => {},
  miseCommand: ["mise"],
  copilotCommand: [process.execPath, here("demo/copilot.ts")],
  version: "idle-cost",
  sessionHook: (event, sessionToken) => sessionHookRequest(api.port, event, sessionToken),
  sessionMcpServer: (sessionToken) => sessionMcpRequest(api.port, sessionToken),
  hostingClis: HOSTING_CLIS,
  userEnv,
  log: () => {},
});
count(Object.getPrototypeOf(facade.agents), "sessions", "agents.sessions()");
count(Object.getPrototypeOf(facade.agents), "sessionsWithoutCycle", "agents.sessionsWithoutCycle() (/ws events)");
// Every way out, a failure and Ctrl+C included, stops the sessions and removes the temporary state directory.
const stop = shutdownOnce(async () => {
  await stopDaemon(home, facade, api);
  await removeFolder(home, removeIfPresent);
});
for (const signal of SHUTDOWN_SIGNALS) process.on(signal, () => void stop(signal));
const api = await startApi({
  token,
  version: "idle-cost",
  info: () => {
    throw new Error("not used");
  },
  onShutdown: () => void stop("POST /api/daemon/shutdown"),
  facade,
  mcp: createMcpEndpoint({ facade, version: "idle-cost", log: () => {} }),
  events: new EventHub({ facade, log: () => {} }),
});

/**
 * Waits until every session has a state (one without has not finished starting), the card warm-up has ended, and no
 * session's state has changed for two seconds, so the phases measure rest. The demo turns leave some sessions in
 * `Working` and `Approval` on purpose, so a state that holds counts as rest, not only `Input`.
 */
async function settle(): Promise<void> {
  const until = Date.now() + 120_000;
  let last = "";
  let sameSince = Date.now();
  while (Date.now() < until) {
    const states = facade.agents.sessions().sessions.map((s) => s.state?.state ?? null);
    const now = states.join(",");
    if (now !== last) [last, sameSince] = [now, Date.now()];
    const started = !states.includes(null) && !facade.cards.warmupProgress().running;
    if (started && Date.now() - sameSince >= 2000) return;
    await Bun.sleep(250);
  }
  throw new Error(`the sessions did not come to rest within 2 minutes: ${last}`);
}

/** CPU of the daemon's ended child processes, from `/proc` on Linux; elsewhere unknown. */
function childCpuMs(): number | undefined {
  if (process.platform !== "linux") return undefined;
  // The fields after the process name, which is in parentheses and may itself hold ") ".
  const stat = readFileSync("/proc/self/stat", "utf8");
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  // `cutime` and `cstime`, in clock ticks of 10 ms (USER_HZ is 100 on every Linux the daemon runs on).
  const ticks = Number(fields[13]) + Number(fields[14]);
  return Number.isFinite(ticks) ? ticks * 10 : undefined;
}

/** The views' refresh of the repo list while repo events come (`REPO_LIST_PACE.live` in the UI). */
const REFRESH_MS = 30_000;

async function statusRound(name: string, ids: readonly string[]): Promise<void> {
  const children = childCpuMs();
  const processes = gitProcessesStarted();
  const cpu = process.cpuUsage();
  const started = performance.now();
  await facade.workspace.repos(ids, "recent");
  const used = process.cpuUsage(cpu);
  const childrenUsed = children === undefined ? undefined : (childCpuMs() ?? 0) - children;
  console.log(`\n${name}: ${(performance.now() - started).toFixed(0)} ms`);
  console.log(`  git processes started: ${gitProcessesStarted() - processes}`);
  console.log(`  daemon CPU ${((used.user + used.system) / 1000).toFixed(0)} ms`);
  if (childrenUsed !== undefined) console.log(`  git processes CPU ${childrenUsed.toFixed(0)} ms`);
}

async function phase(name: string): Promise<void> {
  counts.clear();
  const cpu = process.cpuUsage();
  const started = performance.now();
  await Bun.sleep(seconds * 1000);
  const used = process.cpuUsage(cpu);
  const wall = (performance.now() - started) / 1000;
  const cpuMs = (used.user + used.system) / 1000;
  console.log(`\n${name}: ${wall.toFixed(1)} s`);
  console.log(`  CPU ${cpuMs.toFixed(0)} ms = ${((cpuMs / (wall * 1000)) * 100).toFixed(2)} % of one core`);
  for (const [label, { calls, ms }] of counts) console.log(`  ${label}: ${calls} (${(calls / wall).toFixed(1)}/s), ${ms.toFixed(0)} ms`);
}

try {
  facade.repoWatch.start();
  facade.localConfig.start();
  for (const repo of Object.keys(TURNS)) await facade.agents.start(repo);
  await settle();
  const sessions = facade.agents.sessions().sessions.length;
  console.log(`${sessions} sessions, ${facade.cards.warmupProgress().total} repos, Bun ${Bun.version}, ${process.platform}`);
  await phase("nobody listens to /ws");
  const ws = new WebSocket(`ws://127.0.0.1:${api.port}${EVENTS_SOCKET.path}`, [
    EVENTS_SOCKET.subprotocol,
    `${SOCKET_TOKEN_PREFIX}${token}`,
  ]);
  let frames = 0;
  ws.onmessage = () => frames++;
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("the /ws connection failed")), { once: true });
    ws.addEventListener("close", () => reject(new Error("the daemon closed /ws")), { once: true });
  });
  await Bun.sleep(1000);
  frames = 0;
  // The listener runs in this process, so its share of decoding the frames counts as the daemon's CPU here.
  await phase("one window listens to /ws (its client in the same process)");
  console.log(`  /ws frames: ${frames}`);
  ws.close();

  // A round of repo statuses as the Home and Repos views fetch it every 30 s (`REPO_LIST_PACE`), after the views' first
  // list has read every repo (and remembered the remotes and HEAD commits), then the same round again at once, as another
  // view's would. Both may reuse a status git has had no reason to change (ADR-141); where git is fast, the first reads all.
  const ids = (await facade.workspace.list("recent")).repos.map((repo) => repo.id);
  await Bun.sleep(REFRESH_MS);
  await statusRound(`one round of repo statuses (${ids.length} repos), ${REFRESH_MS / 1000} s after the first list`, ids);
  await statusRound("the same round again at once", ids);
  await stop("done");
  await stop("done");
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  await stop("failed", 1);
}
