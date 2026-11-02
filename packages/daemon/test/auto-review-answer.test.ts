import { describe, expect, test } from "bun:test";
import { ReviewAnswer } from "../src/modules/agents/auto-review-run.ts";

const chunk = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }) as const;

describe("the reviewer's answer from the turn's updates (ADR-182)", () => {
  test("text while a tool call is open is left out, and a tool call or a notice starts a new paragraph", () => {
    const answer = new ReviewAnswer();
    answer.add(chunk("Info: Disabled tools: bash"));
    answer.add(chunk("Reviewing"));
    answer.add(chunk(" now."));
    answer.add({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Review", status: "pending" });
    answer.add(chunk("## Issue: from the review agent"));
    answer.add({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    answer.add(chunk("## Issue: Total is never used"));

    expect(answer.text()).toBe("Info: Disabled tools: bash\n\nReviewing now.\n\n## Issue: Total is never used");
  });

  test("an update without a status does not open a call that already closed", () => {
    const answer = new ReviewAnswer();
    answer.add({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Read" });
    answer.add({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" });
    answer.add({ sessionUpdate: "tool_call_update", toolCallId: "t1" });
    answer.add(chunk("## Issue: Read after the call"));

    expect(answer.text()).toBe("## Issue: Read after the call");
  });

  test("when a tool call never closes, the answer is all the text instead of nothing", () => {
    const answer = new ReviewAnswer();
    answer.add({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Review", status: "in_progress" });
    answer.add(chunk("## Issue: Only inside the call"));

    expect(answer.text()).toBe("## Issue: Only inside the call");
  });
});
