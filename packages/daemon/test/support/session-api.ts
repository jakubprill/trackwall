import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiEnvelope, type Endpoint } from "@trackwall/protocol";
import type { z } from "zod";
import { EventHub } from "../../src/api/event-hub.ts";
import { startApi } from "../../src/api/server.ts";
import { createFacade } from "../../src/facade.ts";
import { COPILOT_HOOK_COMMAND } from "../../src/infra/args.ts";
import { writeDaemonFile } from "../../src/infra/discovery.ts";
import { loopbackRequest } from "../../src/infra/loopback.ts";
import { selfCommand } from "../../src/infra/self-command.ts";
import { createMcpEndpoint } from "../../src/mcp/endpoint.ts";
import { sessionMcpStdioCommand } from "../../src/mcp/stdio-command.ts";
import { makeRepo } from "./git-repo.ts";

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
  /** The built UI the API serves, for a test in a browser (`e2e/`); none by default. */
  uiDir?: string;
}

interface CopilotUnderTest {
  command: readonly string[];
  env: (dirs: { home: string; projects: string }) => NodeJS.ProcessEnv;
}

const FAKE_COPILOT: CopilotUnderTest = { command: [process.execPath, fakeCopilot], env: () => process.env };

export const ONE_REPO: SessionApiOptions = { repos: { shop: { "README.md": "# shop\n" } }, miseCommand: ["mise"] };

/**
 * The daemon API with a real facade and Copilot CLI (by default the fake) in a PTY, on a projects folder with the repos from
 * `options` (by default one repo, `shop`): what `main.ts` gives to `startApi`, with its hook and MCP stdio bridge commands and
 * a `daemon.json`, so a session's bridge reaches this API. `stop` stops the sessions and mise tasks and closes the API.
 */
export async function startSessionApi(token: string, options: SessionApiOptions = ONE_REPO) {
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
  for (const [name, files] of Object.entries(options.repos)) makeRepo(files, name, projects);
  const home = mkdtempSync(join(tmpdir(), "trackwall-home-"));
  writeFileSync(join(home, "workspace.yaml"), `projectsDir: ${JSON.stringify(projects)}\n`);
  const copilot = options.copilot ?? FAKE_COPILOT;
  const facade = createFacade({
    home,
    openUrl: () => {},
    openFolder: () => {},
    miseCommand: options.miseCommand,
    copilotCommand: copilot.command,
    version: "0.0.0-test",
    hookCommand: (event, hooksFile) => selfCommand([COPILOT_HOOK_COMMAND, event, hooksFile]),
    sessionMcpCommand: (tokenFile) => sessionMcpStdioCommand(home, tokenFile),
    userEnv: async () => copilot.env({ home, projects }),
    log: options.log ?? (() => {}),
  });
  const api = await startApi({
    token,
    version: "1",
    uiDir: options.uiDir,
    info: () => {
      throw new Error("unused");
    },
    onShutdown: () => {},
    facade,
    mcp: createMcpEndpoint({ facade, version: "test", log: options.log ?? (() => {}) }),
    events: new EventHub({ facade, log: () => {} }),
  });
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
    await facade.procs.stopAll();
    facade.agents.close();
    await api.close();
  };
  return { api, facade, home, projects, post, stop };
}
