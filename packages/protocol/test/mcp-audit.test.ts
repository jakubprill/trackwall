import { expect, test } from "bun:test";
import { z } from "zod";
import { mcpTools } from "../src/mcp.ts";

/**
 * What an audited argument's schema may be (ADR-152): something that cannot hold free text. A string needs a pattern
 * or a format (a repo id, a task UUID); a mise task name is the one plain string, because it is a name from the repo's
 * trusted mise config that the tool checks against its list.
 */
function identifierKind(schema: z.ZodType, name: string): string | null {
  const json = z.toJSONSchema(schema, { io: "input" });
  const items = json.type === "array" && typeof json.items === "object" && !Array.isArray(json.items) ? json.items : json;
  if (items.enum || items.type === "boolean" || items.type === "integer" || items.type === "number") return "value";
  if (items.type === "string" && (items.pattern || items.format)) return "identifier";
  if (items.type === "string" && name === "miseTask") return "mise task name";
  return null;
}

test("every MCP tool keeps in the audit only arguments that cannot carry free text", () => {
  const freeText = Object.values(mcpTools).flatMap((tool) =>
    tool.auditArgs
      .filter((name) => identifierKind((tool.args.shape as Record<string, z.ZodType>)[name] as z.ZodType, name) === null)
      .map((name) => `${tool.name}.${name}`),
  );
  expect(freeText).toEqual([]);
});

test("the prompt of a proposal, the text of a message and the body of a call to an endpoint are not audited", () => {
  expect(mcpTools.proposeTask.auditArgs).not.toContain("prompt");
  expect(mcpTools.sendMessage.auditArgs).not.toContain("text");
  expect(mcpTools.callEndpoint.auditArgs).toEqual(["repo", "task", "method"]);
});
