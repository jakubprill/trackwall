import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JavaNavigationSettings, Session, SupervisorSettings, ToolPermissions } from "@trackwall/protocol";
import { DomainError } from "../../src/infra/errors.ts";
import { Agents, type AgentsDeps } from "../../src/modules/agents/agents.ts";
import { Logs } from "../../src/modules/logs/logs.ts";
import { stripAnsi } from "../../src/modules/logs/stream-lines.ts";
import { ProcessGroups } from "../../src/modules/procs/process-groups.ts";
import { RuntimeFile } from "../../src/modules/procs/runtime-file.ts";
import { systemTempFolder, Vcs } from "../../src/modules/vcs/vcs.ts";
import { groupPlatform } from "../../src/platform/group-platform.ts";
import { terminalPlatform } from "../../src/platform/terminal.ts";
import { hookServerFor } from "./hook-server.ts";

const fakeCopilot = join(import.meta.dir, "..", "fixtures", "fake-copilot-session.ts");

/**
 * Sessions with a real PTY, a process group, real git and the hooks POSTed to the daemon's hook route (ADR-88);
 * Copilot CLI is a fake. `repos` are the repos of the projects folder: identifier → directory. A `home` passed in
 * simulates a daemon restart with the same state directory. `projectsDir` is where the supervisor runs; `null` is an unset
 * projects folder. `toolPermissions` are the patterns every session gets from the workspace (ADR-66), and
 * `supervisor` is `supervisor` from the workspace (ADR-78). `worktreesDir` is the task worktrees folder the workspace gives
 * new tasks (ADR-84); by default one in `home`, so that a restarted daemon with the same `home` finds the same folder.
 * `miseEnv` is what mise sets for a session (ADR-93); nothing by default. `javaNavigation` is `javaNavigation` from the
 * workspace (ADR-99), read at every task start; not set by default.
 */
export function makeAgents(
  repos: Record<string, string>,
  home = mkdtempSync(join(tmpdir(), "trackwall-agents-")),
  projectsDir: string | null = null,
  toolPermissions: ToolPermissions = { allow: [], deny: [] },
  env: NodeJS.ProcessEnv = process.env,
  supervisor: SupervisorSettings = { changesCode: false },
  worktreesDir: () => string = () => join(home, "task-worktrees"),
  miseEnv: AgentsDeps["miseEnv"] = async () => ({ vars: {}, secretNames: [], secretValues: [], problem: null }),
  javaNavigation: () => JavaNavigationSettings | null = () => null,
) {
  const procs = new ProcessGroups({
    logs: new Logs({ dir: join(home, "logs"), maxFileBytes: 1024 * 1024, log: () => {} }),
    runtime: new RuntimeFile(join(home, "runtime.json")),
    platform: groupPlatform(),
    terminals: terminalPlatform(),
    log: () => {},
  });
  const opened: string[] = [];
  const agents: Agents = new Agents({
    procs,
    repos: {
      repoPath: async (id) => {
        const dir = repos[id];
        if (dir === undefined) throw new DomainError("not_found", `no repo ${id}`);
        return dir;
      },
      projectsDir: async () => {
        if (projectsDir === null) throw new DomainError("bad_request", "set the projects folder first");
        return projectsDir;
      },
      newTaskWorktreesDir: async () => worktreesDir(),
      toolPermissions: () => toolPermissions,
      supervisorSettings: () => supervisor,
      agentSecrets: () => [],
      javaNavigation,
      removeRepo: () => Promise.reject(new Error("unused")),
    },
    vcs: new Vcs(systemTempFolder),
    home,
    copilot: [process.execPath, fakeCopilot],
    version: "0.0.0-test",
    env: async () => env,
    miseEnv,
    sessionHook: hookServerFor(() => agents),
    sessionMcpServer: (sessionToken) => ({ url: "http://127.0.0.1:9/mcp", headers: { "x-trackwall-session-token": sessionToken } }),
    openEditor: (dir) => opened.push(dir),
    boardHas: async () => true,
    onTaskRemoved: () => {},
    log: () => {},
  });
  return { home, procs, agents, opened };
}

export async function waitFor(
  agents: Agents,
  id: string,
  check: (s: Session) => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<Session> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const session = agents.sessions().sessions.find((s) => s.id === id);
    if (session && check(session)) return session;
    if (Date.now() > until) throw new Error(`gave up waiting for: ${what}; last state ${JSON.stringify(session)}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * A fake session terminal: the screen image and the output as text, and whether the daemon closed it. `unwrappedText`
 * is the text without line ends and terminal sequences, for finding what the program printed over several lines.
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
