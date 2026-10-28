import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResumableSessions, sessionLaunch } from "../src/modules/agents/resumable-sessions.ts";

const MAIN = {
  session: "6f1d0a52-2c41-4a8e-9a3f-0c5a1b2d3e4f",
  repo: "shop",
  supervisor: false,
  task: null,
  hasConversation: true,
  view: "terminal" as const,
};
const SUPERVISOR = {
  session: "0b6c9e1a-7d2f-4c3b-8e5a-9f1d2c3b4a5e",
  repo: null,
  supervisor: true,
  task: null,
  hasConversation: false,
  view: "terminal" as const,
};

function newPath(): string {
  return join(mkdtempSync(join(tmpdir(), "trackwall-resumable-")), "resumable-sessions.json");
}

describe("the list of sessions a restart resumes", () => {
  test("follows the running sessions, and the next daemon reads what it held last", () => {
    const path = newPath();
    const list = new ResumableSessions(path, () => {});
    list.follow([MAIN, SUPERVISOR]);
    list.follow([SUPERVISOR]);

    expect(new ResumableSessions(path, () => {}).read()).toEqual([SUPERVISOR]);
  });

  test("once the daemon stops, the sessions its stop ends stay in it", () => {
    const path = newPath();
    const list = new ResumableSessions(path, () => {});
    list.follow([MAIN, SUPERVISOR]);

    list.stopFollowing();
    list.follow([]);

    expect(new ResumableSessions(path, () => {}).read()).toEqual([MAIN, SUPERVISOR]);
  });

  test("a file of a Trackwall before free sessions has no supervisor field, and its session without a repo is the supervisor (ADR-100)", () => {
    const path = newPath();
    const { supervisor: _, ...olderSupervisor } = SUPERVISOR;
    const { supervisor: __, ...olderMain } = MAIN;
    writeFileSync(path, JSON.stringify({ sessions: [olderMain, olderSupervisor] }));

    expect(new ResumableSessions(path, () => {}).read()).toEqual([MAIN, SUPERVISOR]);
  });

  test("a supervisor with a repo breaks the file, so a hand edit never starts the supervisor in place of a main session", () => {
    const path = newPath();
    writeFileSync(path, JSON.stringify({ sessions: [{ ...MAIN, supervisor: true }] }));
    const log: string[] = [];

    expect(new ResumableSessions(path, (msg) => log.push(msg)).read()).toEqual([]);
    expect(log[0]).toContain("no session is resumed");
  });

  test("without a file there is nothing to resume", () => {
    const path = newPath();

    expect(new ResumableSessions(path, () => {}).read()).toEqual([]);
    expect(existsSync(path)).toBe(false);
  });

  test("an id that is not a UUID breaks the file, so it never names a directory outside the sessions folder", () => {
    const path = newPath();
    new ResumableSessions(path, () => {}).follow([MAIN]);
    writeFileSync(path, readFileSync(path, "utf8").replace(MAIN.session, "../../outside"));
    const log: string[] = [];

    expect(new ResumableSessions(path, (msg) => log.push(msg)).read()).toEqual([]);
    expect(log[0]).toContain("no session is resumed");
    expect(existsSync(path)).toBe(false);
  });
});

describe("how a start goes on with a session's conversation", () => {
  const ID = "6f1d0a52-2c41-4a8e-9a3f-0c5a1b2d3e4f";
  const ACP_ID = "776c64bf-f49f-46e9-b18c-2e4a7c7d5473";

  test("a terminal resumes the conversation under the session id, or under Copilot CLI's id of one from the conversation view", () => {
    expect(sessionLaunch("terminal", { session: ID, hasConversation: true })).toEqual({
      view: "terminal",
      id: ID,
      args: [`--resume=${ID}`],
      promptOnStart: false,
      hasConversation: true,
      conversation: ID,
    });
    expect(sessionLaunch("terminal", { session: ID, hasConversation: true, conversation: ACP_ID })).toMatchObject({
      args: [`--resume=${ACP_ID}`],
      conversation: ACP_ID,
    });
  });

  test("the conversation view loads the conversation, and a session without one starts anew in either view", () => {
    expect(sessionLaunch("conversation", { session: ID, hasConversation: true, conversation: ACP_ID })).toEqual({
      view: "conversation",
      id: ID,
      load: ACP_ID,
      firstMessage: undefined,
    });
    expect(sessionLaunch("conversation", { session: ID, hasConversation: true })).toMatchObject({ load: ID });
    expect(sessionLaunch("conversation", { session: ID, hasConversation: false, conversation: ACP_ID })).toMatchObject({ load: undefined });
    expect(sessionLaunch("terminal", { session: ID, hasConversation: false, conversation: ACP_ID })).toMatchObject({
      args: [`--session-id=${ID}`],
      conversation: ID,
    });
  });

  test("a conversation id with anything but letters, digits, - and _ breaks the file, so it never reaches Copilot CLI", () => {
    const path = newPath();
    writeFileSync(path, JSON.stringify({ sessions: [{ ...MAIN, conversation: "../other\nid" }] }));

    expect(new ResumableSessions(path, () => {}).read()).toEqual([]);
  });

  test("a file of a Trackwall before the conversation view lists sessions in a terminal (ADR-107)", () => {
    const path = newPath();
    const { view: _, ...older } = MAIN;
    writeFileSync(path, JSON.stringify({ sessions: [older] }));

    expect(new ResumableSessions(path, () => {}).read()).toEqual([MAIN]);
  });
});
