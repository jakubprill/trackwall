import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MCP_TOOL_DEPRECATIONS, mcpTools } from "../src/mcp.ts";

// The MCP tools as agents know them (§5.3, ADR-278): `fixtures/mcp-tools/<version>.json` keeps every tool a release offered
// with its arguments, each `required` or `optional`. Prompts, skills and instructions name them, so a later Trackwall
// keeps every one: a tool goes only after a release that marked it deprecated, an argument never (`MCP_TOOL_DEPRECATIONS`), and
// no tool gets a new required argument. The newest file is the current contract: a change to the tools writes it again
// (before 1.0) or adds a file for the next version (the failure below shows its content).

type Contract = Record<string, Record<string, "required" | "optional">>;
const Contract = z.record(z.string(), z.record(z.string(), z.enum(["required", "optional"])));

const FIXTURES = join(import.meta.dir, "fixtures", "mcp-tools");
const versionOf = (file: string) => file.replace(/\.json$/, "");
const files = readdirSync(FIXTURES).sort((a, b) => Bun.semver.order(versionOf(a), versionOf(b)));
const read = (file: string): Contract => Contract.parse(JSON.parse(readFileSync(join(FIXTURES, file), "utf8")));

/** The tools as this Trackwall offers them: an argument is optional when the tool takes a call without it. */
function currentContract(): Contract {
  return Object.fromEntries(
    Object.values(mcpTools).map((tool) => [
      tool.name,
      Object.fromEntries(
        Object.entries(tool.args.shape).map(([arg, schema]) => [arg, schema.safeParse(undefined).success ? "optional" : "required"]),
      ),
    ]),
  );
}

describe("the MCP tools agents know from earlier releases", () => {
  const current = currentContract();

  test("the newest file is the current contract", () => {
    const newest = files.at(-1);
    if (newest === undefined) throw new Error("no MCP tools fixture");
    expect({ file: newest, contract: current }).toEqual({ file: newest, contract: read(newest) });
  });

  for (const file of files) {
    test(`every tool and argument of ${versionOf(file)} is still there or was deprecated first, and none became required`, () => {
      for (const [name, args] of Object.entries(read(file))) {
        const now = current[name];
        if (now === undefined) {
          const deprecation = MCP_TOOL_DEPRECATIONS[name];
          expect({ name, removedAfterDeprecation: deprecation?.removedIn != null && deprecation.since !== deprecation.removedIn }).toEqual({
            name,
            removedAfterDeprecation: true,
          });
          continue;
        }
        // An argument stays, and one agents could leave out stays optional; a required one may become optional.
        for (const [arg, kind] of Object.entries(args)) {
          const kept = now[arg] !== undefined && (kind === "required" || now[arg] === "optional");
          expect({ name, arg, was: kind, now: now[arg], kept }).toEqual({ name, arg, was: kind, now: now[arg], kept: true });
        }
        const newRequired = Object.entries(now)
          .filter(([arg, kind]) => kind === "required" && args[arg] === undefined)
          .map(([arg]) => arg);
        expect({ name, newRequired }).toEqual({ name, newRequired: [] });
      }
    });
  }

  test("a deprecated tool says so first in its description, with the version and what to use instead", () => {
    for (const tool of Object.values(mcpTools)) {
      const deprecation = MCP_TOOL_DEPRECATIONS[tool.name];
      if (deprecation === undefined) continue;
      const instead = deprecation.instead === null ? "" : ` Use ${deprecation.instead} instead.`;
      expect(tool.description.startsWith(`Deprecated since ${deprecation.since}.${instead}`)).toBe(true);
    }
  });
});
