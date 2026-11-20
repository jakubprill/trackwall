import { expect, test } from "bun:test";
import { mcpTools } from "../src/mcp.ts";
import { MCP_INSTRUCTIONS } from "../src/mcp-instructions.ts";

test("the MCP instruction sends the agent to the documentation site and its llms.txt", () => {
  expect(MCP_INSTRUCTIONS).toContain(
    "look it up in the documentation (https://jakubprill.github.io/trackwall/; https://jakubprill.github.io/trackwall/llms.txt lists its pages)",
  );
});

test("the MCP instruction proposes work in several repos as one change, and a task per repo only when the user asks (ADR-265)", () => {
  expect(MCP_INSTRUCTIONS).toContain(
    "One piece of work in several repos (an endpoint and its callers, the same fix in a few services) is one propose_change, one part per repo in the order their merge requests are to be merged: one agent makes every part in one conversation",
  );
  expect(MCP_INSTRUCTIONS).toContain("Propose a separate propose_task per repo instead only when the user asks for separate tasks.");
  expect(MCP_INSTRUCTIONS).not.toContain("must fit together");
});

test("propose_change says one agent makes every part, and that it is the default for work in several repos (ADR-265)", () => {
  expect(mcpTools.proposeChange.description).toContain("one agent makes every part in one conversation");
  expect(mcpTools.proposeChange.description).toContain("This is the default for work in several repos");
  expect(mcpTools.proposeChange.description).not.toContain("with its own session");
});
