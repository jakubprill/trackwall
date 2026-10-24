import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Session } from "@trackwall/protocol";
import { DomainError } from "../../src/infra/errors.ts";
import { Agents } from "../../src/modules/agents/agents.ts";
import { Logs } from "../../src/modules/logs/logs.ts";
import { stripAnsi } from "../../src/modules/logs/stream-lines.ts";
import { ProcessGroups } from "../../src/modules/procs/process-groups.ts";
import { RuntimeFile } from "../../src/modules/procs/runtime-file.ts";
import { Vcs } from "../../src/modules/vcs/vcs.ts";
import { groupPlatform } from "../../src/platform/group-platform.ts";
import { terminalPlatform } from "../../src/platform/terminal.ts";

const fakeCopilot = join(import.meta.dir, "..", "fixtures", "fake-copilot-session.ts");
const daemonMain = join(import.meta.dir, "..", "..", "src", "main.ts");

/**
 * Sesje z prawdziwym PTY, grupą procesów, prawdziwym gitem i hookami przez podkomendę `copilot-hook` daemona;
 * Copilot CLI to atrapa. `repos` to repo z folderu z projektami: identyfikator → katalog. `home` podany z zewnątrz
 * udaje restart daemona z tym samym katalogiem stanu.
 */
export function makeAgents(repos: Record<string, string>, home = mkdtempSync(join(tmpdir(), "trackwall-agents-"))) {
  const procs = new ProcessGroups({
    logs: new Logs({ dir: join(home, "logs"), maxFileBytes: 1024 * 1024, log: () => {} }),
    runtime: new RuntimeFile(join(home, "runtime.json")),
    platform: groupPlatform(),
    terminals: terminalPlatform(),
    log: () => {},
  });
  const opened: string[] = [];
  const agents = new Agents({
    procs,
    repos: {
      repoPath: async (id) => {
        const dir = repos[id];
        if (dir === undefined) throw new DomainError("not_found", `nie ma repo ${id}`);
        return dir;
      },
    },
    vcs: new Vcs(),
    home,
    copilot: [process.execPath, fakeCopilot],
    env: async () => process.env,
    hookCommand: (event, hooksFile) => ({ exec: process.execPath, args: ["--no-env-file", daemonMain, "copilot-hook", event, hooksFile] }),
    mcpStdioCommand: ["trackwall-daemon", "mcp-stdio"],
    openEditor: (dir) => opened.push(dir),
    log: () => {},
  });
  return { home, procs, agents, opened };
}

export async function waitFor(agents: Agents, id: string, check: (s: Session) => boolean, what: string): Promise<Session> {
  const until = Date.now() + 20_000;
  for (;;) {
    const session = agents.sessions().sessions.find((s) => s.id === id);
    if (session && check(session)) return session;
    if (Date.now() > until) throw new Error(`nie doczekano się: ${what}; ostatni stan ${JSON.stringify(session)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Okno terminala na niby: obraz ekranu i wyjście jako tekst oraz to, czy daemon je zamknął. `unwrappedText` to tekst
 * bez końców linii i sekwencji terminala, do szukania tego, co program wypisał w kilku liniach.
 */
export function viewer(agents: Agents, id: string) {
  let screen = "";
  let closed = false;
  const decoder = new TextDecoder();
  const attachment = agents.attach(
    id,
    (bytes) => {
      screen += decoder.decode(bytes, { stream: true });
    },
    (snapshot) => {
      screen += snapshot;
    },
    () => {
      closed = true;
    },
  );
  return {
    attachment,
    text: () => screen,
    unwrappedText: () => stripAnsi(screen).replace(/[\r\n]/g, ""),
    closed: () => closed,
  };
}
