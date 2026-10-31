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
 * string with a pattern or a length limit is not enough (an endpoint's path has a pattern and carries a query); it
 * must be one of these, recognised by its definition, which `.describe()` and `.optional()` keep.
 */
const IDENTIFIERS: z.ZodType[] = [RepoId, TaskId, SessionId, BoardItemId, TagName, MiseTaskName, TaskModel];

/** The schema under `.optional()`, `.default()`, `.nullable()` and `z.array()`. */
function inner(schema: z.ZodType): z.ZodType {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault || schema instanceof z.ZodNullable)
    return inner(schema.unwrap() as z.ZodType);
  if (schema instanceof z.ZodArray) return inner(schema.element as z.ZodType);
  return schema;
}

function isIdentifier(schema: z.ZodType): boolean {
  const value = inner(schema);
  if (value instanceof z.ZodEnum || value instanceof z.ZodBoolean || value instanceof z.ZodNumber) return true;
  return IDENTIFIERS.some((id) => id.def === value.def);
}

test("a plain string of a limited length, or one with a pattern of its own, does not count as an identifier", () => {
  expect(isIdentifier(z.string().min(1).max(200))).toBe(false);
  expect(isIdentifier(z.string().regex(/^\//))).toBe(false);
  expect(isIdentifier(RepoId.optional().describe("the repo"))).toBe(true);
});

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
