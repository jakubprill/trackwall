import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunState, Session } from "@trackwall/protocol";
import type { AgentSession } from "../src/modules/agents/agent-session.ts";
import { LastSupervisorFile } from "../src/modules/agents/last-supervisor.ts";
import { ListedSessions } from "../src/modules/agents/listed-sessions.ts";
import { ResumableSessions } from "../src/modules/agents/resumable-sessions.ts";
import { type SessionMiseEnv, sessionMiseLaunch } from "../src/modules/agents/session-env.ts";
import { sessionDir, sessionOwner } from "../src/modules/agents/session-launcher.ts";
import { SessionTokens } from "../src/modules/agents/session-tokens.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const MISE: SessionMiseEnv = { vars: { MAVEN_OPTS: "-Xmx2g" }, secretNames: [], secretValues: [], profile: null, problem: null };

/** A session of either view that only answers what the list asks; `running` is whether its process group runs. */
function fakeSession(
  id: string,
  place: { supervisor?: boolean; task?: string | null; running?: boolean } = {},
): AgentSession & { disposed: boolean } {
  const run: RunState = place.running === false ? ({ kind: "exited" } as RunState) : ({ kind: "running" } as RunState);
  const fake: AgentSession & { disposed: boolean } = {
    id,
    repo: place.supervisor ? null : "shop",
    supervisor: place.supervisor ?? false,
    task: place.task ?? null,
    sessionView: "terminal",
    hasConversation: true,
    conversation: id,
    disposed: false,
    tick: () => run.kind === "running",
    view: () => ({ id, run }) as Session,
    askToRead: () => "typed",
    hookOutput: () => ({}),
    answerDialog: () => {},
    dispose() {
      fake.disposed = true;
    },
  };
  return fake;
}

/** `running` says, by its owner key in `procs`, whether a session's process group runs. */
function makeList(running: (owner: string) => boolean = () => true) {
  const home = mkdtempSync(join(tmpdir(), "trackwall-listed-"));
  homes.push(home);
  const tokens = new SessionTokens();
  const list = new ListedSessions({
    state: (owner) => ({ kind: running(owner) ? "running" : "exited" }) as RunState,
    home,
    tokens,
    resumable: new ResumableSessions(join(home, "resumable-sessions.json"), () => {}),
    lastSupervisor: new LastSupervisorFile(join(home, "last-supervisor.json"), () => {}),
    log: () => {},
  });
  return { list, tokens, home };
}

function add(list: ListedSessions, session: AgentSession): void {
  list.add({ session, miseEnv: MISE, mise: sessionMiseLaunch(MISE, {}, []) });
}

describe("listed sessions", () => {
  test("a session that leaves the list loses its token and its directory and is disposed", () => {
    const { list, tokens, home } = makeList();
    const session = fakeSession("s1");
    const token = tokens.issue("s1");
    mkdirSync(sessionDir(home, "s1"), { recursive: true });
    add(list, session);

    list.remove(session);

    expect(list.has("s1")).toBe(false);
    expect(tokens.session(token)).toBeUndefined();
    expect(existsSync(sessionDir(home, "s1"))).toBe(false);
    expect(session.disposed).toBe(true);
    expect(() => list.get("s1")).toThrow(expect.objectContaining({ code: "not_found" }));
    list.close();
  });

  test("the views come newest first", () => {
    const { list } = makeList();
    add(list, fakeSession("old"));
    add(list, fakeSession("new"));

    expect(list.views().map((s) => s.id)).toEqual(["new", "old"]);
    list.close();
  });

  test("a task's running session is its newest one whose process runs", () => {
    const { list } = makeList();
    add(list, fakeSession("old", { task: "t1" }));
    add(list, fakeSession("new", { task: "t1" }));
    add(list, fakeSession("ended", { task: "t1", running: false }));

    expect(list.runningOfTask("t1")?.id).toBe("new");
    list.close();
  });

  test("every tick writes the sessions that run for the next daemon to resume", async () => {
    const { list, home } = makeList();
    add(list, fakeSession("main"));
    add(list, fakeSession("ended", { running: false }));

    await Bun.sleep(300);

    const resumable = JSON.parse(readFileSync(join(home, "resumable-sessions.json"), "utf8"));
    expect(resumable.sessions).toEqual([
      { session: "main", repo: "shop", supervisor: false, task: null, view: "terminal", hasConversation: true },
    ]);
    list.close();
  });

  test("at daemon exit the sessions whose groups still run are written for the next daemon, with the newest supervisor", () => {
    const { list, home } = makeList((owner) => owner !== sessionOwner("stopped"));
    add(list, fakeSession("main"));
    add(list, fakeSession("stopped"));
    add(list, fakeSession("boss", { supervisor: true }));

    list.keepRunningForResume();
    list.close();

    const resumable = JSON.parse(readFileSync(join(home, "resumable-sessions.json"), "utf8"));
    expect(resumable.sessions.map((s: { session: string }) => s.session)).toEqual(["main", "boss"]);
    const last = JSON.parse(readFileSync(join(home, "last-supervisor.json"), "utf8"));
    expect(last).toEqual({ session: "boss", hasConversation: true });
  });

  test("the environment a session started with is compared with what mise gives it now", () => {
    const { list } = makeList();
    add(list, fakeSession("s1"));
    const now: SessionMiseEnv = { ...MISE, vars: { MAVEN_OPTS: "-Xmx4g" } };

    expect(list.environmentChange("s1", MISE, sessionMiseLaunch(MISE, {}, []))).toBeNull();
    expect(list.environmentChange("s1", now, sessionMiseLaunch(now, {}, []))).toMatchObject({ changed: ["MAVEN_OPTS"] });
    list.close();
  });

  test("a session that leaves the list leaves no environment to compare", () => {
    const { list } = makeList();
    const session = fakeSession("s1");
    add(list, session);

    list.remove(session);

    expect(list.environmentChange("s1", MISE, sessionMiseLaunch(MISE, {}, []))).toBeNull();
    list.close();
  });
});
