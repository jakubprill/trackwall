import { describe, expect, test } from "bun:test";
import type { ConversationEntry } from "@trackwall/protocol";
import {
  conversationStatus,
  conversationTurns,
  readSupervisorView,
  saveSupervisorView,
  sendsMessage,
  withEntries,
} from "../src/lib/conversation.ts";

describe("the conversation view", () => {
  test("a frame adds new entries at the end and replaces the ones with its ids, and a reset starts over", () => {
    const first = withEntries([], {
      type: "entries",
      reset: true,
      waiting: [],
      entries: [
        { id: "user-1", kind: "user", text: "Check the build" },
        { id: "tool-1", kind: "tool", title: "Run tests", tool: "execute", status: "pending", detail: [] },
      ],
    });
    const next = withEntries(first, {
      type: "entries",
      reset: false,
      waiting: [],
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
    expect(withEntries(next, { type: "entries", reset: true, entries: [], waiting: [] })).toEqual([]);
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

describe("whose turn it is in the conversation view", () => {
  const at = "2026-11-01T10:00:00.000Z";
  const state = (s: "Working" | "Input" | "Approval" | "Error") =>
    ({ state: s, source: "acp", confidence: "exact", at, reason: "" }) as const;

  test("the line above the message box says whether the agent works, may be stuck, asks for approval, failed or waits for the user", () => {
    expect(conversationStatus({ state: null, stuck: null })).toEqual({ tone: "warning", label: "Starting the session…" });
    expect(conversationStatus({ state: state("Working"), stuck: null })).toEqual({ tone: "ok", label: "The agent is working…" });
    expect(conversationStatus({ state: state("Working"), stuck: { lastStepAt: at } }).label).toBe(
      "The agent may be stuck: nothing new from it for a while",
    );
    expect(conversationStatus({ state: state("Approval"), stuck: null })).toEqual({
      tone: "warning",
      label: "The agent asks for your approval",
    });
    expect(conversationStatus({ state: state("Error"), stuck: null }).tone).toBe("error");
    expect(conversationStatus({ state: state("Input"), stuck: null })).toEqual({
      tone: "ok",
      label: "Your turn: the agent waits for your message",
    });
  });
});

describe("turns of the conversation view", () => {
  test("each user message is a turn, and the agent's answers and tool calls between two of them are one turn named by its first entry", () => {
    const run: ConversationEntry = { id: "tool-1", kind: "tool", title: "Run tests", tool: "execute", status: "completed", detail: [] };
    expect(
      conversationTurns([
        { id: "user-1", kind: "user", text: "Check the build" },
        { id: "agent-1", kind: "agent", text: "Running the tests." },
        run,
        { id: "agent-2", kind: "agent", text: "Green." },
        { id: "user-2", kind: "user", text: "Thanks" },
      ]),
    ).toEqual([
      { kind: "user", entry: { id: "user-1", kind: "user", text: "Check the build" } },
      {
        kind: "agent",
        id: "agent-1",
        steps: [{ id: "agent-1", kind: "agent", text: "Running the tests." }, run, { id: "agent-2", kind: "agent", text: "Green." }],
      },
      { kind: "user", entry: { id: "user-2", kind: "user", text: "Thanks" } },
    ]);
    expect(conversationTurns([])).toEqual([]);
  });
});
