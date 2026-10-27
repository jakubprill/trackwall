import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResumableSessions } from "../src/modules/agents/resumable-sessions.ts";

const MAIN = { session: "6f1d0a52-2c41-4a8e-9a3f-0c5a1b2d3e4f", repo: "shop", supervisor: false, task: null, hasConversation: true };
const SUPERVISOR = { session: "0b6c9e1a-7d2f-4c3b-8e5a-9f1d2c3b4a5e", repo: null, supervisor: true, task: null, hasConversation: false };

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
    const { supervisor: _, ...older } = SUPERVISOR;
    writeFileSync(path, JSON.stringify({ sessions: [older] }));

    expect(new ResumableSessions(path, () => {}).read()).toEqual([SUPERVISOR]);
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
