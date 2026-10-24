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

/**
 * API daemona z prawdziwą fasadą i atrapą Copilot CLI w PTY, na folderze z projektami z jednym repo `sklep`: to, co
 * `main.ts` podaje do `startApi`. `stop` zatrzymuje sesje i zamyka API.
 */
export async function startSessionApi(token: string) {
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
  const repo = makeRepo({ "README.md": "# sklep\n" }, "sklep", projects);
  const home = mkdtempSync(join(tmpdir(), "trackwall-home-"));
  writeFileSync(join(home, "workspace.yaml"), `projectsDir: ${JSON.stringify(projects)}\n`);
  const facade = createFacade({
    home,
    openUrl: () => {},
    miseCommand: ["mise"],
    copilotCommand: [process.execPath, fakeCopilot],
    hookCommand: (event, hooksFile) => ({ exec: process.execPath, args: ["--no-env-file", daemonMain, "copilot-hook", event, hooksFile] }),
    mcpStdioCommand: ["trackwall-daemon", "mcp-stdio"],
    userEnv: async () => process.env,
    log: () => {},
  });
  const api = await startApi({
    token,
    version: "1",
    info: () => {
      throw new Error("nieużywane");
    },
    onShutdown: () => {},
    facade,
    mcp: createMcpEndpoint({ facade, version: "test", log: () => {} }),
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
  return { api, facade, repo, post, stop };
}
