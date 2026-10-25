import { expect, test } from "bun:test";
import { MCP_INSTRUCTIONS } from "../src/mcp-instructions.ts";

test("the MCP instruction sends the agent to the documentation site and its llms.txt", () => {
  expect(MCP_INSTRUCTIONS).toContain(
    "look it up in the documentation (https://jakubprill.github.io/trackwall/; https://jakubprill.github.io/trackwall/llms.txt lists its pages)",
  );
});
