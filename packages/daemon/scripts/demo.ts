/**
 * A daemon on a made-up shop of twenty repos, for screenshots and demos: it creates the repos in a new state
 * directory, points the projects folder at them and runs sessions with a stand-in for Copilot CLI
 * (`scripts/demo/copilot.ts`), so nothing reaches a model. mise tasks run with the real `mise` when it is on PATH.
 *
 *   pnpm --filter @trackwall/daemon demo <empty state directory>
 *
 * It prints the address of the UI (`packages/ui/dist`, so build the UI first) and writes `daemon.json` like the real
 * daemon, once the scene is set. Ctrl+C stops it with everything it started.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EventHub } from "../src/api/event-hub.ts";
import { sessionHookRequest } from "../src/api/hooks.ts";
import { startApi } from "../src/api/server.ts";
import { createFacade, HOSTING_CLIS } from "../src/facade.ts";
import { newToken, writeDaemonFile } from "../src/infra/discovery.ts";
import { SHUTDOWN_SIGNALS, shutdownOnce, stopDaemon } from "../src/infra/shutdown.ts";
import { userEnv } from "../src/infra/user-env.ts";
import { createMcpEndpoint, sessionMcpRequest } from "../src/mcp/endpoint.ts";
import { mcpStdioCommand } from "../src/mcp/stdio-command.ts";
import { runtimeInfo } from "../src/platform/runtime.ts";
import { TURNS } from "./demo/turns.ts";
import { createDemoWorkspace, DEMO_REPOS, writePricingTaskChanges } from "./demo/workspace.ts";

const VERSION = "demo";
const dir = process.argv[2];
if (dir === undefined) throw new Error("usage: bun scripts/demo.ts <empty state directory>");
const home = resolve(dir);
if (existsSync(home) && readdirSync(home).length > 0) throw new Error(`${home} is not empty`);

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const uiDir = here("../../ui/dist");
if (!existsSync(join(uiDir, "index.html"))) throw new Error("no built UI: run `pnpm --filter @trackwall/ui build` first");

const projectsDir = join(home, "projects");
mkdirSync(projectsDir, { recursive: true });
createDemoWorkspace(projectsDir);
writeFileSync(join(home, "workspace.yaml"), `projectsDir: ${JSON.stringify(projectsDir)}\n`);

const log = (msg: string) => process.stderr.write(`[demo] ${msg}\n`);
const facade = createFacade({
  home,
  openUrl: (url) => log(`open ${url}`),
  openFolder: (folder) => log(`open ${folder}`),
  miseCommand: ["mise"],
  copilotCommand: [process.execPath, here("demo/copilot.ts")],
  version: VERSION,
  sessionHook: (event, sessionToken) => sessionHookRequest(api.port, token, event, sessionToken),
  sessionMcpServer: (sessionToken) => sessionMcpRequest(api.port, token, sessionToken),
  hostingClis: HOSTING_CLIS,
  userEnv,
  log,
});
const stop = shutdownOnce(async (reason) => {
  log(`stopping (${reason})`);
  await stopDaemon(home, facade, api);
});
const token = newToken();
const startedAt = new Date().toISOString();
const api = await startApi({
  token,
  version: VERSION,
  uiDir,
  info: () => ({
    version: VERSION,
    pid: process.pid,
    startedAt,
    uptimeMs: Math.round(process.uptime() * 1000),
    platform: platform(),
    arch: arch(),
    runtime: runtimeInfo(),
    launchedBy: "manual",
    home,
    mcpStdioCommand: mcpStdioCommand(home),
  }),
  onShutdown: () => void stop("POST /api/daemon/shutdown"),
  facade,
  mcp: createMcpEndpoint({ facade, version: VERSION, log: (msg) => log(`[mcp] ${msg}`) }),
  events: new EventHub({ facade, log: (msg) => log(`[events] ${msg}`) }),
});
/**
 * Sessions in every state, a main session with two of its tasks approved (one with its messages) and two still proposed, two tasks of their
 * own (the pricing one verified, with a failed test), and a slice of services running.
 */
async function setTheScene(): Promise<void> {
  const sessions = [];
  for (const repo of Object.keys(TURNS)) sessions.push(await facade.agents.start(repo));
  const main = sessions[0];
  if (main === undefined) throw new Error("no main session");
  const propose = (repo: string, title: string, prompt: string) => facade.agents.propose(main.id, { repo, title, prompt });
  const retry = await propose(
    "payments",
    "Retry the payment call",
    "Make POST /api/payments idempotent by order id, so orders-api can retry it twice.",
  );
  const notify = await propose(
    "notifications",
    "Tell the customer about a retried payment",
    "Send one e-mail when a payment succeeds on a retry, not one per attempt.",
  );
  await propose(
    "admin-web",
    "Show retries on the order page",
    "Show how many times the payment of an order was retried, next to its status.",
  );
  await propose(
    "billing",
    "Invoice an order once, however often it is paid",
    "Skip the invoice when billing already has one for the order id.",
  );
  for (const proposal of [retry, notify]) await facade.agents.approveProposal(proposal.id, proposal.prompt, proposal.model);
  // The main session steers its notifications task (ADR-68): its agent has read the first message, not the second yet.
  facade.agents.sendMessage(
    main.id,
    notify.id,
    "payments now answers a retried POST /api/payments with 200 and the first attempt's payment id, so one order has one payment id however often it is retried.",
  );
  const notifySession = facade.agents.sessions().sessions.find((session) => session.task === notify.id);
  if (notifySession === undefined) throw new Error("the notifications task has no session");
  facade.agents.takeMessages(notifySession.id);
  facade.agents.sendMessage(
    main.id,
    notify.id,
    "Send the e-mail from the payment.succeeded event of that id only, and say in your summary which template you used.",
  );
  const pricing = await facade.agents.createTask("pricing", "Publish a price-changed event when a price changes");
  writePricingTaskChanges(pricing.worktree);
  await facade.agents.createTask("reviews", "Hide reviews from customers who have been deleted");
  for (const repo of DEMO_REPOS) await facade.mise.trust(repo);
  // The pricing task's tests fail on what its review comment asks for, so its panel shows a failed verification (ADR-64).
  const verified = await facade.verifications.verify(pricing.id, undefined, 30_000, AbortSignal.timeout(30_000));
  if (verified.state !== "failed") throw new Error(`the pricing task's verification is ${verified.state}, not failed`);
  const slice = await facade.services.start({ repo: "admin-bff", task: null, dependencies: true, waitMs: 20_000 });
  const down = slice.members
    .filter((member) => member.service?.state !== "healthy")
    .map((member) => `${member.repo}: ${member.problem ?? member.service?.state ?? member.outcome}`);
  if (down.length > 0) throw new Error(`services did not come up (another demo still running?): ${down.join(", ")}`);
  await facade.mise.start({ repo: "orders-api", task: null }, "build");
}

for (const signal of SHUTDOWN_SIGNALS) process.on(signal, () => void stop(signal));

try {
  await setTheScene();
} catch (err) {
  await stop(`the scene did not come up: ${err instanceof Error ? err.message : String(err)}`, 1);
}
// Written once the scene is set, so whoever waits for daemon.json finds the demo ready.
writeDaemonFile(home, { pid: process.pid, port: api.port, token, startedAt, version: VERSION });
log(`demo shop in ${projectsDir}`);
log(`UI: http://127.0.0.1:${api.port}/#token=${token}`);
