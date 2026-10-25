import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiEnvelope, type Endpoint } from "@trackwall/protocol";
import type { z } from "zod";
import { EventHub } from "../../src/api/event-hub.ts";
import { startApi } from "../../src/api/server.ts";
import { createFacade } from "../../src/facade.ts";
import { loopbackRequest } from "../../src/infra/loopback.ts";
import { createMcpEndpoint } from "../../src/mcp/endpoint.ts";
import { makeRepo } from "./git-repo.ts";

const fakeCopilot = join(import.meta.dir, "..", "fixtures", "fake-copilot-session.ts");
const daemonMain = join(import.meta.dir, "..", "..", "src", "main.ts");

/** Projects-folder repos and the `mise` program for a test that needs something other than the single repo `sklep`. */
interface SessionApiOptions {
  /** Repo name and its files in the first commit. */
  repos: Record<string, Record<string, string>>;
  miseCommand: readonly string[];
  /** Daemon log lines (the MCP audit lines among them); dropped without it. */
  log?: (msg: string) => void;
}

const ONE_REPO: SessionApiOptions = { repos: { sklep: { "README.md": "# sklep\n" } }, miseCommand: ["mise"] };

/**
 * API daemona z prawdziwą fasadą i atrapą Copilot CLI w PTY, na folderze z projektami z repo z `options` (domyślnie
 * jedno repo `sklep`): to, co `main.ts` podaje do `startApi`. `stop` zatrzymuje sesje i taski i zamyka API.
 */
export async function startSessionApi(token: string, options: SessionApiOptions = ONE_REPO) {
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
  for (const [name, files] of Object.entries(options.repos)) makeRepo(files, name, projects);
  const home = mkdtempSync(join(tmpdir(), "trackwall-home-"));
  writeFileSync(join(home, "workspace.yaml"), `projectsDir: ${JSON.stringify(projects)}\n`);
  const facade = createFacade({
    home,
    openUrl: () => {},
    openFolder: () => {},
    miseCommand: options.miseCommand,
    copilotCommand: [process.execPath, fakeCopilot],
    hookCommand: (event, hooksFile) => ({ exec: process.execPath, args: ["--no-env-file", daemonMain, "copilot-hook", event, hooksFile] }),
    sessionMcpCommand: (tokenFile) => ["trackwall-daemon", "mcp-stdio", "--session-token-file", tokenFile],
    userEnv: async () => process.env,
    log: options.log ?? (() => {}),
  });
  const api = await startApi({
    token,
    version: "1",
    info: () => {
      throw new Error("nieużywane");
    },
    onShutdown: () => {},
    facade,
    mcp: createMcpEndpoint({ facade, version: "test", log: options.log ?? (() => {}) }),
    events: new EventHub({ facade, log: () => {} }),
  });
  /** Akcja API z tokenem; wynik sprawdzony schematem akcji. */
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
