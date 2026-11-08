import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { FollowedStateFile, readStateFile, stateFormat, writeStateFile } from "../src/infra/state-file.ts";

// The format version of state files and their migrations (ADR-223).

const Tasks = z.object({ tasks: z.array(z.object({ id: z.string(), title: z.string() })) });

/** Version 3: version 2 renamed `name` to `title`, version 3 moved the list from `items` to `tasks`. */
const tasksFormat = stateFormat(Tasks, [
  (file) => ({
    ...file,
    items: z
      .array(z.looseObject({ name: z.string() }))
      .parse(file.items)
      .map(({ name, ...rest }) => ({ ...rest, title: name })),
  }),
  ({ items, ...rest }) => ({ ...rest, tasks: items }),
]);

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), "trackwall-state-file-"));
}

function read(path: string): { value: unknown; problems: string[] } {
  const problems: string[] = [];
  const value = readStateFile(path, tasksFormat, (problem) => problems.push(problem));
  return { value, problems };
}

describe("a state file's format version (ADR-223)", () => {
  test("a file is written with its format's version, which is one more than its migrations, and reads back", () => {
    const path = join(stateDir(), "tasks.json");
    writeStateFile(path, tasksFormat, { tasks: [{ id: "a", title: "Fix the total" }] });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 3, tasks: [{ id: "a", title: "Fix the total" }] });
    expect(read(path)).toEqual({ value: { tasks: [{ id: "a", title: "Fix the total" }] }, problems: [] });
  });

  test("a file without a version is version 1 and goes through every migration", () => {
    const path = join(stateDir(), "tasks.json");
    writeFileSync(path, JSON.stringify({ items: [{ id: "a", name: "Fix the total" }] }));

    expect(read(path)).toEqual({ value: { tasks: [{ id: "a", title: "Fix the total" }] }, problems: [] });
  });

  test("a file of version 2 goes only through the migrations after its own", () => {
    const path = join(stateDir(), "tasks.json");
    writeFileSync(path, JSON.stringify({ version: 2, items: [{ id: "a", title: "Fix the total" }] }));

    expect(read(path)).toEqual({ value: { tasks: [{ id: "a", title: "Fix the total" }] }, problems: [] });
  });

  test("a file a newer Trackwall wrote is not read and moved aside as newer, so nothing overwrites it", () => {
    const dir = stateDir();
    const path = join(dir, "tasks.json");
    writeFileSync(path, JSON.stringify({ version: 4, tasks: [] }));

    expect(read(path)).toEqual({ value: undefined, problems: ["written by a newer Trackwall (state format 4, this one reads up to 3)"] });
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(dir).filter((name) => name.startsWith("tasks.json.newer-"))).toHaveLength(1);
  });

  test.each([
    ["a version 0", '{"version": 0, "tasks": []}'],
    ["a version given as text", '{"version": "2", "tasks": []}'],
    ["a JSON array", "[]"],
  ])("a file with %s is broken and moved aside", (_, text) => {
    const dir = stateDir();
    const path = join(dir, "tasks.json");
    writeFileSync(path, text);

    expect(read(path)).toEqual({ value: undefined, problems: ["not an object with a valid version"] });
    expect(readdirSync(dir).filter((name) => name.startsWith("tasks.json.broken-"))).toHaveLength(1);
  });

  test("a file a migration cannot read is moved aside as broken instead of stopping the daemon", () => {
    const dir = stateDir();
    const path = join(dir, "tasks.json");
    writeFileSync(path, JSON.stringify({ items: "not a list" }));

    const { value, problems } = read(path);
    expect(value).toBeUndefined();
    expect(problems).toHaveLength(1);
    expect(problems[0]).toStartWith("migration to state format 2 failed: ");
    expect(readdirSync(dir).filter((name) => name.startsWith("tasks.json.broken-"))).toHaveLength(1);
  });

  test("a followed file writes its format's version", () => {
    const path = join(stateDir(), "tasks.json");
    const file = new FollowedStateFile(path, tasksFormat, { broken: () => {}, log: () => {} });
    file.follow({ tasks: [] });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ version: 3, tasks: [] });
  });
});
