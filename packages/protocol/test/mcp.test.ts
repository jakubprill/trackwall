import { describe, expect, test } from "bun:test";
import { TASK_CHECK_STEP_MAX, TASK_SUMMARY_MAX, TASK_SUMMARY_WORDS } from "../src/agents.ts";
import { mcpTools } from "../src/mcp.ts";
import { MERGE_REQUEST_DESCRIPTION_MAX } from "../src/merge-requests.ts";

describe("reporting a task's result (report_result)", () => {
  const schema = JSON.stringify(mcpTools.reportResult.args.toJSONSchema());

  test("the tool's schema asks for a summary in words and says how many characters are refused", () => {
    expect(schema).toContain(`the result for the reviewer in about ${TASK_SUMMARY_WORDS} words`);
    expect(schema).toContain(`more than ${TASK_SUMMARY_MAX} characters is refused`);
  });

  test("the tool's schema tells the model that each check step is one line of limited length", () => {
    expect(schema).toContain(`one step on one line, without line breaks or tabs, up to ${TASK_CHECK_STEP_MAX} characters`);
  });

  test("a summary fits the merge request's description it becomes", () => {
    expect(TASK_SUMMARY_MAX).toBeLessThanOrEqual(MERGE_REQUEST_DESCRIPTION_MAX);
  });
});
