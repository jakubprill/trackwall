import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LastSupervisorFile } from "../src/modules/agents/last-supervisor.ts";

const SUPERVISOR = "0b6c9e1a-7d2f-4c3b-8e5a-9f1d2c3b4a5e";

function newPath(): string {
  return join(mkdtempSync(join(tmpdir(), "trackwall-last-supervisor-")), "last-supervisor.json");
}

describe("the newest supervisor whose conversation a start goes on with", () => {
  test("follows the newest supervisor, and the next daemon reads it", () => {
    const path = newPath();
    const file = new LastSupervisorFile(path, () => {});
    file.follow({ session: SUPERVISOR, hasConversation: false });
    file.follow({ session: SUPERVISOR, hasConversation: true });

    expect(new LastSupervisorFile(path, () => {}).read()).toEqual({ session: SUPERVISOR, hasConversation: true });
  });

  test("an unchanged supervisor is not written again", () => {
    const path = newPath();
    const file = new LastSupervisorFile(path, () => {});
    file.follow({ session: SUPERVISOR, hasConversation: true });
    writeFileSync(path, JSON.stringify({ session: SUPERVISOR, hasConversation: true, written: "by hand" }));
    const before = statSync(path).mtimeMs;

    file.follow({ session: SUPERVISOR, hasConversation: true });

    expect(statSync(path).mtimeMs).toBe(before);
  });

  test("a supervisor of the conversation view keeps Copilot CLI's id of its conversation", () => {
    const path = newPath();
    const conversation = "776c64bf-f49f-46e9-b18c-2e4a7c7d5473";
    new LastSupervisorFile(path, () => {}).follow({ session: SUPERVISOR, hasConversation: true, conversation });

    expect(new LastSupervisorFile(path, () => {}).read()).toEqual({
      session: SUPERVISOR,
      hasConversation: true,
      conversation,
    });
  });

  test("without a file there is none", () => {
    const path = newPath();

    expect(new LastSupervisorFile(path, () => {}).read()).toBeNull();
    expect(existsSync(path)).toBe(false);
  });

  test("a missing file is read once: every session cycle asks, and only the daemon writes the file", () => {
    const path = newPath();
    const file = new LastSupervisorFile(path, () => {});
    expect(file.read()).toBeNull();

    writeFileSync(path, JSON.stringify({ session: SUPERVISOR, hasConversation: true }));

    expect(file.read()).toBeNull();
  });

  test("an id that is not a UUID breaks the file, which is moved aside, and there is none", () => {
    const path = newPath();
    writeFileSync(path, JSON.stringify({ session: "../outside", hasConversation: true }));
    const log: string[] = [];

    expect(new LastSupervisorFile(path, (msg) => log.push(msg)).read()).toBeNull();
    expect(log[0]).toContain("no supervisor conversation is resumed");
    expect(readdirSync(dirname(path)).filter((name) => name.startsWith("last-supervisor.json.broken-"))).toHaveLength(1);
  });
});
