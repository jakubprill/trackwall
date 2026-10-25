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
import { startApi } from "../src/api/server.ts";
import { createFacade } from "../src/facade.ts";
import { COPILOT_HOOK_COMMAND, MCP_STDIO_COMMAND, SESSION_TOKEN_FILE_OPTION } from "../src/infra/args.ts";
import { newToken, removeDaemonFile, writeDaemonFile } from "../src/infra/discovery.ts";
import { userEnv } from "../src/infra/user-env.ts";
import { createMcpEndpoint } from "../src/mcp/endpoint.ts";
import { runtimeInfo } from "../src/platform/runtime.ts";
import { createDemoWorkspace, DEMO_REPOS } from "./demo/workspace.ts";

const VERSION = "demo";
const dir = process.argv[2];
if (dir === undefined) throw new Error("usage: bun scripts/demo.ts <empty state directory>");
const home = resolve(dir);
if (existsSync(home) && readdirSync(home).length > 0) throw new Error(`${home} is not empty`);

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const mainScript = here("../src/main.ts");
const uiDir = here("../../ui/dist");
if (!existsSync(join(uiDir, "index.html"))) throw new Error("no built UI: run `pnpm --filter @trackwall/ui build` first");

const projectsDir = join(home, "projects");
mkdirSync(projectsDir, { recursive: true });
createDemoWorkspace(projectsDir);
writeFileSync(join(home, "workspace.yaml"), `projectsDir: ${JSON.stringify(projectsDir)}\n`);

const log = (msg: string) => process.stderr.write(`[demo] ${msg}\n`);
// Hooks and the MCP bridge run the daemon from source, as `bun src/main.ts` would.
const daemon = (args: string[]) => ({ exec: process.execPath, args: [mainScript, ...args] });
const facade = createFacade({
  home,
  openUrl: (url) => log(`open ${url}`),
  openFolder: (folder) => log(`open ${folder}`),
  miseCommand: ["mise"],
  copilotCommand: [process.execPath, here("demo/copilot.ts")],
  hookCommand: (event, hooksFile) => daemon([COPILOT_HOOK_COMMAND, event, hooksFile]),
  sessionMcpCommand: (tokenFile) => {
    const { exec, args } = daemon([MCP_STDIO_COMMAND, "--home", home, SESSION_TOKEN_FILE_OPTION, tokenFile]);
    return [exec, ...args];
  },
  userEnv,
  log,
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
    mcpStdioCommand: [process.execPath, mainScript, MCP_STDIO_COMMAND, "--home", home],
  }),
  onShutdown: () => void stop(),
  facade,
  mcp: createMcpEndpoint({ facade, version: VERSION, log }),
  events: new EventHub({ facade, log }),
});
/** Sessions in every state, a main session with proposals, two agent tasks and a running slice of services. */
async function setTheScene(): Promise<void> {
  const sessions = ["orders-api", "payments", "shop-web", "catalog", "inventory", "search", "api-gateway", "admin-bff", "shipping"];
  const started = [];
  for (const repo of sessions) started.push(await facade.agents.start(repo));
  const main = started[0];
  if (main === undefined) throw new Error("no main session");
  await facade.agents.propose(main.id, {
    repo: "payments",
    title: "Retry the payment call",
    prompt: "Make POST /api/payments idempotent by order id, so orders-api can retry it twice.",
  });
  await facade.agents.propose(main.id, {
    repo: "notifications",
    title: "Tell the customer about a retried payment",
    prompt: "Send one e-mail when a payment succeeds on a retry, not one per attempt.",
  });
  await facade.agents.propose(main.id, {
    repo: "admin-web",
    title: "Show retries on the order page",
    prompt: "Show how many times the payment of an order was retried, next to its status.",
  });
  await facade.agents.createTask("pricing", "Publish a price-changed event when a price changes");
  await facade.agents.createTask("reviews", "Hide reviews from customers who have been deleted");
  for (const repo of DEMO_REPOS) await facade.mise.trust(repo);
  await facade.services.start({ repo: "admin-bff", dependencies: true, waitMs: 20_000 });
  await facade.mise.start("orders-api", "build");
}

async function stop(): Promise<void> {
  facade.batch.close();
  await facade.procs.stopAll();
  facade.agents.close();
  removeDaemonFile(home, process.pid);
  await api.close();
  facade.logs.flush();
  process.exit(0);
}
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());

await setTheScene();
// Written once the scene is set, so whoever waits for daemon.json finds the demo ready.
writeDaemonFile(home, { pid: process.pid, port: api.port, token, startedAt, version: VERSION });
log(`demo shop in ${projectsDir}`);
log(`UI: http://127.0.0.1:${api.port}/#token=${token}`);
