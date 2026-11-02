import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { AcpConversation } from "../src/modules/agents/acp-conversation.ts";

const text = (t: string) => ({ type: "text" as const, text: t });
const CWD = join("/", "repo");

describe("the conversation built from ACP updates", () => {
  test("message chunks join into one entry until the other side speaks or a tool runs", () => {
    const conversation = new AcpConversation(CWD);
    conversation.said("Check the build");
    conversation.apply({ sessionUpdate: "agent_message_chunk", content: text("Looking ") });
    conversation.apply({ sessionUpdate: "agent_message_chunk", content: text("at it.") });
    conversation.apply({ sessionUpdate: "tool_call", toolCallId: "call_1", title: "Run tests", kind: "execute", status: "pending" });
    conversation.apply({ sessionUpdate: "agent_message_chunk", content: text("All green.") });

    expect(conversation.entries()).toEqual([
      { id: "user-1", kind: "user", text: "Check the build" },
      { id: "agent-2", kind: "agent", text: "Looking at it." },
      {
        id: "tool-3",
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
      { id: "agent-4", kind: "agent", text: "All green." },
    ]);
  });

  test("a tool call's updates change its entry, and apply returns the entry it changed", () => {
    const conversation = new AcpConversation(CWD);
    conversation.apply({
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "Say hi",
      kind: "execute",
      status: "pending",
      rawInput: { command: "echo hi" },
    });

    const changed = conversation.apply({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      content: [{ type: "content", content: text("hi\n<shellId: 0 completed with exit code 0>") }],
    });

    expect(changed).toEqual({
      entries: [
        {
          id: "tool-1",
          kind: "tool",
          title: "Say hi",
          tool: "execute",
          status: "completed",
          files: [],
          detail: ["hi", "<shellId: 0 completed with exit code 0>"],
          patch: "",
          patchCut: false,
          subagent: null,
        },
      ],
      reset: false,
    });
    expect(conversation.entries()).toHaveLength(1);
  });

  test("a new tool call with the id of an earlier one, as after a loaded conversation, is a new entry", () => {
    const conversation = new AcpConversation(CWD);
    conversation.apply({ sessionUpdate: "tool_call", toolCallId: "call_1_0", title: "Before the load", status: "completed" });
    conversation.apply({ sessionUpdate: "tool_call", toolCallId: "call_1_0", title: "After the load", status: "pending" });
    conversation.apply({ sessionUpdate: "tool_call_update", toolCallId: "call_1_0", status: "completed" });

    expect(conversation.entries().map((e) => e.kind === "tool" && [e.title, e.status])).toEqual([
      ["Before the load", "completed"],
      ["After the load", "completed"],
    ]);
  });

  test("updates without text (an image, usage, a title) change nothing", () => {
    const conversation = new AcpConversation(CWD);

    expect(conversation.apply({ sessionUpdate: "agent_message_chunk", content: { type: "image" } })).toEqual({ entries: [], reset: false });
    expect(conversation.apply({ sessionUpdate: "session_info_update", title: "run echo" })).toEqual({ entries: [], reset: false });
    expect(conversation.entries()).toEqual([]);
  });

  test("the oldest entries go beyond 1000, and then the views get the whole conversation again", () => {
    const conversation = new AcpConversation(CWD);
    for (let i = 1; i <= 1000; i++) conversation.said(`message ${i}`);

    const change = conversation.said("message 1001");

    expect(change.reset).toBe(true);
    expect(change.entries).toHaveLength(1000);
    expect(change.entries[0]).toMatchObject({ text: "message 2" });
  });

  test("the oldest entries go once the conversation holds over 4 Mi characters", () => {
    const conversation = new AcpConversation(CWD);
    for (let i = 0; i < 25; i++) conversation.said("x".repeat(200_000));

    expect(conversation.entries().length).toBe(20);
  });

  test("a tool's title and kind are cut to what the protocol allows", () => {
    const conversation = new AcpConversation(CWD);
    conversation.apply({ sessionUpdate: "tool_call", toolCallId: "call_1", title: "t".repeat(5000), kind: "k".repeat(500) });

    const [entry] = conversation.entries();
    expect(entry?.kind === "tool" && [entry.title.length, entry.tool.length]).toEqual([1000, 64]);
  });

  test("clear forgets the conversation before a load replays it", () => {
    const conversation = new AcpConversation(CWD);
    conversation.said("first");
    conversation.clear();
    conversation.apply({ sessionUpdate: "user_message_chunk", content: text("first") });

    expect(conversation.entries()).toEqual([{ id: "user-2", kind: "user", text: "first" }]);
  });

  test("a message longer than an entry keeps its end", () => {
    const conversation = new AcpConversation(CWD);
    conversation.apply({ sessionUpdate: "agent_message_chunk", content: text("a".repeat(200_000)) });
    conversation.apply({ sessionUpdate: "agent_message_chunk", content: text("THE END") });

    const [entry] = conversation.entries();
    expect(entry?.kind === "agent" && entry.text.length).toBe(200_000);
    expect(entry?.kind === "agent" && entry.text.endsWith("THE END")).toBe(true);
  });
  test("the agent's thought chunks join into one thought entry, apart from its answer", () => {
    const conversation = new AcpConversation(CWD);
    conversation.apply({ sessionUpdate: "agent_thought_chunk", content: text("The total ignores ") });
    conversation.apply({ sessionUpdate: "agent_thought_chunk", content: text("discounts.") });
    conversation.apply({ sessionUpdate: "agent_message_chunk", content: text("Fixing the total.") });

    expect(conversation.entries()).toEqual([
      { id: "thought-1", kind: "thought", text: "The total ignores discounts." },
      { id: "agent-2", kind: "agent", text: "Fixing the total." },
    ]);
  });

  test("an edit's entry has its file relative to the working directory, and its change once the tool ran", () => {
    const conversation = new AcpConversation(CWD);
    const file = join(CWD, "src", "total.ts");
    conversation.apply({
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: `Editing ${file}`,
      kind: "edit",
      status: "pending",
      locations: [{ path: file }],
      content: [{ type: "diff", path: file, oldText: "four\n", newText: "FOUR\n" }],
    });
    const patch =
      "diff --git a/repo/src/total.ts b/repo/src/total.ts\n--- a/repo/src/total.ts\n+++ b/repo/src/total.ts\n@@ -3,2 +3,2 @@\n three\n-four\n+FOUR\n";
    conversation.apply({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      content: [{ type: "diff", path: file, oldText: "four\n", newText: "FOUR\n" }],
      rawOutput: { content: "File updated with changes.", detailedContent: `\n${patch}` },
    });

    expect(conversation.entries()).toEqual([
      {
        id: "tool-1",
        kind: "tool",
        title: `Editing ${file}`,
        tool: "edit",
        status: "completed",
        files: [join("src", "total.ts")],
        detail: [],
        patch,
        patchCut: false,
        subagent: null,
      },
    ]);
  });

  test("a subagent's tool call says the subagent's type and what it was asked, and its answer is the tool's detail", () => {
    const conversation = new AcpConversation(CWD);
    const rawInput = { description: "Find callers", prompt: "List every caller of the total.", agent_type: "explore", name: "finder" };
    conversation.apply({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Find callers", kind: "other", status: "pending", rawInput });
    conversation.apply({
      sessionUpdate: "tool_call_update",
      toolCallId: "t1",
      status: "completed",
      content: [{ type: "content", content: text("Two callers.") }],
      rawOutput: { content: "Two callers.", detailedContent: "Two callers." },
    });

    expect(conversation.entries()).toEqual([
      {
        id: "tool-1",
        kind: "tool",
        title: "Find callers",
        tool: "other",
        status: "completed",
        files: [],
        detail: ["Two callers."],
        patch: "",
        patchCut: false,
        subagent: { type: "explore", prompt: "List every caller of the total." },
      },
    ]);
  });
});
