import { describe, expect, test } from "bun:test";
import { readSupervisorView, saveSupervisorView, sendsMessage, withEntries } from "../src/lib/conversation.ts";

describe("the conversation view", () => {
  test("a frame adds new entries at the end and replaces the ones with its ids, and a reset starts over", () => {
    const first = withEntries([], {
      type: "entries",
      reset: true,
      entries: [
        { id: "user-1", kind: "user", text: "Check the build" },
        { id: "tool-1", kind: "tool", title: "Run tests", tool: "execute", status: "pending", detail: [] },
      ],
    });
    const next = withEntries(first, {
      type: "entries",
      reset: false,
      entries: [
        { id: "tool-1", kind: "tool", title: "Run tests", tool: "execute", status: "completed", detail: ["ok"] },
        { id: "agent-2", kind: "agent", text: "Green." },
      ],
    });

    expect(next).toEqual([
      { id: "user-1", kind: "user", text: "Check the build" },
      { id: "tool-1", kind: "tool", title: "Run tests", tool: "execute", status: "completed", detail: ["ok"] },
      { id: "agent-2", kind: "agent", text: "Green." },
    ]);
    expect(withEntries(next, { type: "entries", reset: true, entries: [] })).toEqual([]);
  });

  test("Enter sends the message, Shift+Enter and Enter of an input method do not", () => {
    expect(sendsMessage({ key: "Enter", shiftKey: false, isComposing: false })).toBe(true);
    expect(sendsMessage({ key: "Enter", shiftKey: true, isComposing: false })).toBe(false);
    expect(sendsMessage({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(sendsMessage({ key: "a", shiftKey: false, isComposing: false })).toBe(false);
  });

  test("the supervisor starts in a terminal until the user picks the conversation view, also when storage fails", () => {
    const stored = new Map<string, string>();
    const storage = () => ({ getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) });
    const broken = () => {
      throw new Error("storage is off");
    };

    expect(readSupervisorView(storage)).toBe("terminal");
    saveSupervisorView(storage, "conversation");
    expect(readSupervisorView(storage)).toBe("conversation");
    expect(readSupervisorView(broken)).toBe("terminal");
    expect(() => saveSupervisorView(broken, "conversation")).not.toThrow();
  });
});
