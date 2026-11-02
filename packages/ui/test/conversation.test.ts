import { describe, expect, test } from "bun:test";
import type { ConversationEntry } from "@trackwall/protocol";
import {
  contextMeter,
  conversationStatus,
  conversationTurns,
  NO_CONVERSATION_INFO,
  readSupervisorView,
  saveSupervisorView,
  sendsMessage,
  slashSuggestions,
  toolSubtitle,
  withConversationInfo,
  withEntries,
  withSlashCommand,
} from "../src/lib/conversation.ts";

describe("the conversation view", () => {
  test("a frame adds new entries at the end and replaces the ones with its ids, and a reset starts over", () => {
    const first = withEntries([], {
      type: "entries",
      reset: true,
      waiting: [],
      entries: [
        { id: "user-1", kind: "user", text: "Check the build" },
        {
          id: "tool-1",
          kind: "tool",
          title: "Run tests",
          tool: "execute",
          status: "pending",
          files: [],
          detail: [],
          patch: "",
          patchCut: false,
          subagent: null,
        },
      ],
    });
    const next = withEntries(first, {
      type: "entries",
      reset: false,
      waiting: [],
      entries: [
        {
          id: "tool-1",
          kind: "tool",
          title: "Run tests",
          tool: "execute",
          status: "completed",
          files: [],
          detail: ["ok"],
          patch: "",
          patchCut: false,
          subagent: null,
        },
        { id: "agent-2", kind: "agent", text: "Green." },
      ],
    });

    expect(next).toEqual([
      { id: "user-1", kind: "user", text: "Check the build" },
      {
        id: "tool-1",
        kind: "tool",
        title: "Run tests",
        tool: "execute",
        status: "completed",
        files: [],
        detail: ["ok"],
        patch: "",
        patchCut: false,
        subagent: null,
      },
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
  test("each user message is a turn, and the agent's answers, thoughts and tool calls between two of them are one turn named by its first entry", () => {
    const run: ConversationEntry = {
      id: "tool-1",
      kind: "tool",
      title: "Run tests",
      tool: "execute",
      status: "completed",
      files: [],
      detail: [],
      patch: "",
      patchCut: false,
      subagent: null,
    };
    expect(
      conversationTurns([
        { id: "user-1", kind: "user", text: "Check the build" },
        { id: "agent-1", kind: "agent", text: "Running the tests." },
        run,
        { id: "agent-2", kind: "agent", text: "Green." },
        { id: "thought-1", kind: "thought", text: "The tests pass." },
        { id: "user-2", kind: "user", text: "Thanks" },
      ]),
    ).toEqual([
      { kind: "user", entry: { id: "user-1", kind: "user", text: "Check the build" } },
      {
        kind: "agent",
        id: "agent-1",
        steps: [
          { id: "agent-1", kind: "agent", text: "Running the tests." },
          run,
          { id: "agent-2", kind: "agent", text: "Green." },
          { id: "thought-1", kind: "thought", text: "The tests pass." },
        ],
      },
      { kind: "user", entry: { id: "user-2", kind: "user", text: "Thanks" } },
    ]);
    expect(conversationTurns([])).toEqual([]);
  });
});

describe("the line under a tool call's title", () => {
  test("a subagent shows its type, a shell tool its command, another tool its files, and a tool with none of them nothing", () => {
    expect(toolSubtitle({ tool: "other", detail: [], files: [], subagent: { type: "explore", prompt: "Find callers" } })).toBe(
      "Subagent · explore",
    );
    expect(toolSubtitle({ tool: "execute", detail: ["$ pnpm test", "ok"], files: [], subagent: null })).toBe("$ pnpm test");
    expect(toolSubtitle({ tool: "edit", detail: [], files: ["src/total.ts", "src/total.test.ts"], subagent: null })).toBe(
      "src/total.ts, src/total.test.ts",
    );
    expect(toolSubtitle({ tool: "other", detail: ["3 rows"], files: [], subagent: null })).toBeUndefined();
  });
});

describe("the agent's mode, context use and commands in the conversation view", () => {
  const plan = {
    current: "mode#plan",
    options: [
      { id: "mode#agent", name: "Agent", description: "" },
      { id: "mode#plan", name: "Plan", description: "" },
    ],
  };
  const compact = { name: "compact", description: "Summarize the conversation", hint: "focus instructions" };

  test("a frame changes only what it carries, and a reset starts from nothing", () => {
    const first = withConversationInfo(NO_CONVERSATION_INFO, {
      type: "entries",
      reset: true,
      entries: [],
      waiting: [],
      mode: plan,
      context: null,
      commands: [compact],
    });
    const next = withConversationInfo(first, { type: "entries", reset: false, entries: [], waiting: [], context: { used: 10, size: 100 } });

    expect(next).toEqual({ mode: plan, context: { used: 10, size: 100 }, commands: [compact] });
    expect(withConversationInfo(next, { type: "entries", reset: true, entries: [], waiting: [] })).toEqual(NO_CONVERSATION_INFO);
  });

  test("the context meter is a whole percent of the window and warns from 75%", () => {
    expect(contextMeter({ used: 10_777, size: 128_000 })).toEqual({ percent: 8, tone: "ok" });
    expect(contextMeter({ used: 96_000, size: 128_000 })).toEqual({ percent: 75, tone: "warning" });
    expect(contextMeter({ used: 200, size: 100 })).toEqual({ percent: 100, tone: "warning" });
  });

  test("a slash at the start lists the commands that start with what follows it, until a space", () => {
    const review = { name: "review", description: "Review the changes", hint: "" };
    const chronicle = { name: "chronicle", description: "Session history", hint: "" };
    const commands = [compact, review, chronicle];

    expect(slashSuggestions("/", commands)).toEqual(commands);
    expect(slashSuggestions("/C", commands)).toEqual([compact, chronicle]);
    expect(slashSuggestions("/compact now", commands)).toEqual([]);
    expect(slashSuggestions("fix /c", commands)).toEqual([]);
    expect(slashSuggestions("/x", commands)).toEqual([]);
    // A whole command lists nothing, so Enter sends it.
    expect(slashSuggestions("/compact", commands)).toEqual([]);
    expect(withSlashCommand(compact)).toBe("/compact ");
  });

  test("at most eight commands are suggested at once", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ name: `c${i}`, description: "", hint: "" }));

    expect(slashSuggestions("/c", many)).toHaveLength(8);
  });
});
