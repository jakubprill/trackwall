import { expect, test } from "bun:test";
import { z } from "zod";
import { SessionId, TaskId, TaskModel } from "../src/agents.ts";
import { BoardItemId } from "../src/board.ts";
import { TagName } from "../src/cards.ts";
import { mcpTools } from "../src/mcp.ts";
import { MiseTaskName } from "../src/mise.ts";
import { RepoId } from "../src/workspace.ts";

/**
 * The schemas an audited argument may have (ADR-152): identifiers the daemon checks, which cannot hold free text. A
 * string with any pattern is not enough (an endpoint's path has one and carries a query); it must be one of these.
 */
const IDENTIFIERS = [RepoId, TaskId, SessionId, BoardItemId, TagName, MiseTaskName, TaskModel];

/** A schema as JSON Schema without its description, so `RepoArg` and `RepoId` compare equal. */
function shapeOf(schema: z.ZodType): string {
  const { description: _, $schema: _version, ...json } = z.toJSONSchema(schema, { io: "input" });
  const items = json.type === "array" && typeof json.items === "object" && !Array.isArray(json.items) ? json.items : json;
  const { description: _item, ...plain } = items;
  return JSON.stringify(plain);
}

const IDENTIFIER_SHAPES = new Set(IDENTIFIERS.map(shapeOf));

function isIdentifier(schema: z.ZodType): boolean {
  const shape = JSON.parse(shapeOf(schema));
  return Boolean(shape.enum) || ["boolean", "integer", "number"].includes(shape.type) || IDENTIFIER_SHAPES.has(shapeOf(schema));
}

test("every MCP tool keeps in the audit only arguments that cannot carry free text", () => {
  const freeText = Object.values(mcpTools).flatMap((tool) =>
    tool.auditArgs
      .filter((name) => !isIdentifier((tool.args.shape as Record<string, z.ZodType>)[name] as z.ZodType))
      .map((name) => `${tool.name}.${name}`),
  );
  expect(freeText).toEqual([]);
});

test("the prompt of a proposal, the text of a message and the body of a call to an endpoint are not audited", () => {
  expect(mcpTools.proposeTask.auditArgs).not.toContain("prompt");
  expect(mcpTools.sendMessage.auditArgs).not.toContain("text");
  expect(mcpTools.callEndpoint.auditArgs).toEqual(["repo", "task", "method"]);
});
