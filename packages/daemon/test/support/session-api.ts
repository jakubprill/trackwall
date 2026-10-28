import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiEnvelope, type Endpoint } from "@trackwall/protocol";
import type { z } from "zod";
import { EventHub } from "../../src/api/event-hub.ts";
import { sessionHookRequest } from "../../src/api/hooks.ts";
import { startApi } from "../../src/api/server.ts";
import { createFacade, type FacadeOptions, HOSTING_CLIS } from "../../src/facade.ts";
import { writeDaemonFile } from "../../src/infra/discovery.ts";
import { loopbackRequest } from "../../src/infra/loopback.ts";
import { createMcpEndpoint, sessionMcpRequest } from "../../src/mcp/endpoint.ts";
import type { HostingClis } from "../../src/modules/vcs/hosting.ts";
import { makeRepo } from "./git-repo.ts";
import { recordingToolLists } from "./mcp-tool-lists.ts";

const fakeCopilot = join(import.meta.dir, "..", "fixtures", "fake-copilot-session.ts");

/** Projects-folder repos and the `mise` program for a test that needs something other than the single repo `shop`. */
export interface SessionApiOptions {
  /** Repo name and its files in the first commit. */
  repos: Record<string, Record<string, string>>;
  miseCommand: readonly string[];
  /** Daemon log lines (the MCP audit lines among them); dropped without it. */
  log?: (msg: string) => void;
  /** Copilot CLI and the environment of its sessions, made for the test's directories; the fake by default. */
  copilot?: CopilotUnderTest;
  /** Where the session plugin's hooks go instead of this daemon's hook route, for a test of a failing hook. */
  sessionHook?: FacadeOptions["sessionHook"];
  /** The built UI the API serves, for a test in a browser (`e2e/`); none by default. */
  uiDir?: string;
  /** `gh` and `glab`; the real programs by default, which a test that reaches a repo host replaces with the fake. */
  hostingClis?: HostingClis;
  /**
   * The state directory and projects folder of a stopped daemon: this one starts in them as the daemon after a restart,
   * and resumes the sessions that one left running (ADR-95); new ones by default.
   */
  restartOf?: { home: string; projects: string };
  /** Addresses the daemon asks the system to open; dropped without it. */
  openUrl?: (url: string) => void;
}

interface CopilotUnderTest {
  command: readonly string[];
  env: (dirs: { home: string; projects: string }) => NodeJS.ProcessEnv;
}

const FAKE_COPILOT: CopilotUnderTest = { command: [process.execPath, fakeCopilot], env: () => process.env };

export const ONE_REPO: SessionApiOptions = { repos: { shop: { "README.md": "# shop\n" } }, miseCommand: ["mise"] };

/**
 * The daemon API with a real facade and Copilot CLI (by default the fake) in a PTY, on a projects folder with the repos from
 * `options` (by default one repo, `shop`): what `main.ts` gives to `startApi`, with its hook and MCP addresses and
 * a `daemon.json`, so a session's hooks and MCP requests reach this API. `stop` stops the sessions and mise tasks and closes the API;
 * `hasListedTools` tells whether the MCP server has answered a session's `tools/list`.
 */
export async function startSessionApi(token: string, options: SessionApiOptions = ONE_REPO) {
  const { home, projects } = options.restartOf ?? newDirs(options.repos);
  const copilot = options.copilot ?? FAKE_COPILOT;
  const facade = createFacade({
    home,
    homeFrom: "flag",
    openUrl: options.openUrl ?? (() => {}),
    openFolder: () => {},
    miseCommand: options.miseCommand,
    copilotCommand: copilot.command,
    version: "0.0.0-test",
    sessionHook: options.sessionHook ?? ((event, sessionToken) => sessionHookRequest(api.port, token, event, sessionToken)),
    sessionMcpServer: (sessionToken) => sessionMcpRequest(api.port, token, sessionToken),
    hostingClis: options.hostingClis ?? HOSTING_CLIS,
    userEnv: async () => copilot.env({ home, projects }),
    log: options.log ?? (() => {}),
  });
  const mcp = recordingToolLists(createMcpEndpoint({ facade, version: "test", log: options.log ?? (() => {}) }));
  facade.agents.sweepLeftovers();
  const api = await startApi({
    token,
    version: "1",
    uiDir: options.uiDir,
    info: () => {
      throw new Error("unused");
    },
    onShutdown: () => {},
    facade,
    mcp: mcp.endpoint,
    events: new EventHub({ facade, log: () => {} }),
  });
  // As in main.ts: before the API the leftovers of the previous daemon, after it the sessions it left running.
  void facade.agents.resumeLeftSessions();
  writeDaemonFile(home, { pid: process.pid, port: api.port, token, startedAt: new Date().toISOString(), version: "0.0.0-test" });
  /** An API action with the token; the result checked by the action's schema. */
  async function post<Req extends z.ZodType, Data extends z.ZodType>(
    endpoint: Endpoint<Req, Data>,
    body: z.input<Req>,
  ): Promise<z.output<Data>> {
    const res = await loopbackRequest(api.port, endpoint.path, { method: "POST", token, body: JSON.stringify(body), timeoutMs: 10_000 });
    const result = ApiEnvelope.parse(JSON.parse(res.body));
    if (!result.ok) throw new Error(`${endpoint.path}: ${result.error.message}`);
    return endpoint.data.parse(result.data);
  }
  const stop = async () => {
    facade.agents.keepRunningSessionsForResume();
    await facade.procs.stopAll();
    facade.agents.close();
    await api.close();
  };
  return { api, facade, home, projects, post, stop, hasListedTools: mcp.hasListedTools };
}

/** A projects folder with `repos` and a state directory whose workspace points to it. */
function newDirs(repos: SessionApiOptions["repos"]): { home: string; projects: string } {
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
  for (const [name, files] of Object.entries(repos)) makeRepo(files, name, projects);
  const home = mkdtempSync(join(tmpdir(), "trackwall-home-"));
  writeFileSync(join(home, "workspace.yaml"), `projectsDir: ${JSON.stringify(projects)}\n`);
  return { home, projects };
}
