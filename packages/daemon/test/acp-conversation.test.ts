import { describe, expect, test } from "bun:test";
import { AcpConversation, toolCallLines } from "../src/modules/agents/acp-conversation.ts";

const text = (t: string) => ({ type: "text" as const, text: t });

describe("the conversation built from ACP updates", () => {
  test("message chunks join into one entry until the other side speaks or a tool runs", () => {
    const conversation = new AcpConversation();
    conversation.said("Check the build");
    conversation.apply({ sessionUpdate: "agent_message_chunk", content: text("Looking ") });
    conversation.apply({ sessionUpdate: "agent_message_chunk", content: text("at it.") });
    conversation.apply({ sessionUpdate: "tool_call", toolCallId: "call_1", title: "Run tests", kind: "execute", status: "pending" });
    conversation.apply({ sessionUpdate: "agent_message_chunk", content: text("All green.") });

    expect(conversation.entries()).toEqual([
      { id: "user-1", kind: "user", text: "Check the build" },
      { id: "agent-2", kind: "agent", text: "Looking at it." },
      { id: "tool-3", kind: "tool", title: "Run tests", tool: "execute", status: "pending", detail: [] },
      { id: "agent-4", kind: "agent", text: "All green." },
    ]);
  });

  test("a tool call's updates change its entry, and apply returns the entry it changed", () => {
    const conversation = new AcpConversation();
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
          detail: ["hi", "<shellId: 0 completed with exit code 0>"],
        },
      ],
      reset: false,
    });
    expect(conversation.entries()).toHaveLength(1);
  });

  test("a new tool call with the id of an earlier one, as after a loaded conversation, is a new entry", () => {
    const conversation = new AcpConversation();
    conversation.apply({ sessionUpdate: "tool_call", toolCallId: "call_1_0", title: "Before the load", status: "completed" });
    conversation.apply({ sessionUpdate: "tool_call", toolCallId: "call_1_0", title: "After the load", status: "pending" });
    conversation.apply({ sessionUpdate: "tool_call_update", toolCallId: "call_1_0", status: "completed" });

    expect(conversation.entries().map((e) => e.kind === "tool" && [e.title, e.status])).toEqual([
      ["Before the load", "completed"],
      ["After the load", "completed"],
    ]);
  });

  test("updates without text (an image, usage, a title) change nothing", () => {
    const conversation = new AcpConversation();

    expect(conversation.apply({ sessionUpdate: "agent_message_chunk", content: { type: "image" } })).toEqual({ entries: [], reset: false });
    expect(conversation.apply({ sessionUpdate: "session_info_update", title: "run echo" })).toEqual({ entries: [], reset: false });
    expect(conversation.entries()).toEqual([]);
  });

  test("the oldest entries go beyond 1000, and then the views get the whole conversation again", () => {
    const conversation = new AcpConversation();
    for (let i = 1; i <= 1000; i++) conversation.said(`message ${i}`);

    const change = conversation.said("message 1001");

    expect(change.reset).toBe(true);
    expect(change.entries).toHaveLength(1000);
    expect(change.entries[0]).toMatchObject({ text: "message 2" });
  });

  test("the oldest entries go once the conversation holds over 4 Mi characters", () => {
    const conversation = new AcpConversation();
    for (let i = 0; i < 25; i++) conversation.said("x".repeat(200_000));

    expect(conversation.entries().length).toBe(20);
  });

  test("a tool's title and kind are cut to what the protocol allows", () => {
    const conversation = new AcpConversation();
    conversation.apply({ sessionUpdate: "tool_call", toolCallId: "call_1", title: "t".repeat(5000), kind: "k".repeat(500) });

    const [entry] = conversation.entries();
    expect(entry?.kind === "tool" && [entry.title.length, entry.tool.length]).toEqual([1000, 64]);
  });

  test("clear forgets the conversation before a load replays it", () => {
    const conversation = new AcpConversation();
    conversation.said("first");
    conversation.clear();
    conversation.apply({ sessionUpdate: "user_message_chunk", content: text("first") });

    expect(conversation.entries()).toEqual([{ id: "user-2", kind: "user", text: "first" }]);
  });

  test("a message longer than an entry keeps its end", () => {
    const conversation = new AcpConversation();
    conversation.apply({ sessionUpdate: "agent_message_chunk", content: text("a".repeat(200_000)) });
    conversation.apply({ sessionUpdate: "agent_message_chunk", content: text("THE END") });

    const [entry] = conversation.entries();
    expect(entry?.kind === "agent" && entry.text.length).toBe(200_000);
    expect(entry?.kind === "agent" && entry.text.endsWith("THE END")).toBe(true);
  });
});

describe("the lines of a tool call", () => {
  test("a file diff names the file, then the removed and the added lines", () => {
    expect(toolCallLines({ content: [{ type: "diff", path: "/repo/a.txt", oldText: "one", newText: "one\ntwo" }] })).toEqual([
      "/repo/a.txt",
      "- one",
      "+ one",
      "+ two",
    ]);
  });

  test("an approval of a shell command shows the command, and one of a file edit the diff Copilot CLI sends in its input", () => {
    expect(toolCallLines({ rawInput: { command: "npm test", commands: ["npm test"] } })).toEqual(["$ npm test"]);
    expect(
      toolCallLines({ rawInput: { fileName: "/repo/a.txt", diff: "\n--- a/dev/null\n+++ b/repo/a.txt\n@@ -1,0 +1,1 @@\n+one\n" } }),
    ).toEqual(["--- a/dev/null", "+++ b/repo/a.txt", "@@ -1,0 +1,1 @@", "+one"]);
  });

  test("a failed tool says why, and other output of a failed or running tool is not read", () => {
    expect(toolCallLines({ status: "failed", rawOutput: { message: "The user rejected this tool call." } })).toEqual([
      "The user rejected this tool call.",
    ]);
    expect(toolCallLines({ status: "completed", rawOutput: { message: "not shown" } })).toEqual([]);
  });

  test("a long output is cut at 64 Ki characters, also inside a line", () => {
    const lines = toolCallLines({ content: [{ type: "content", content: text(`${"a".repeat(60_000)}\n${"b".repeat(60_000)}\nc`) }] });

    expect(lines.map((l) => l.length)).toEqual([60_000, 64 * 1024 - 60_000]);
  });

  test("a long output is cut at 400 lines", () => {
    const lines = toolCallLines({
      content: [{ type: "content", content: text(Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n")) }],
    });

    expect(lines).toHaveLength(400);
    expect(lines.at(-1)).toBe("line 399");
  });
});
