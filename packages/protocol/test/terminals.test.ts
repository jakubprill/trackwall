import { describe, expect, test } from "bun:test";
import { PlaceFile, TerminalPlace } from "../src/terminals.ts";

const TASK = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("places of folder terminals and their files", () => {
  test("a place is the projects folder, a repo root or a task's worktree in its repo", () => {
    expect(TerminalPlace.safeParse({ repo: null, task: null }).success).toBe(true);
    expect(TerminalPlace.safeParse({ repo: "shop", task: null }).success).toBe(true);
    expect(TerminalPlace.safeParse({ repo: "shop", task: TASK }).success).toBe(true);
    expect(PlaceFile.safeParse({ repo: null, task: null, path: "shop/build" }).success).toBe(true);
  });

  test("a task without its repo, or a place with anything else in it, is no place", () => {
    expect(TerminalPlace.safeParse({ repo: null, task: TASK }).success).toBe(false);
    expect(PlaceFile.safeParse({ repo: null, task: TASK, path: "" }).success).toBe(false);
    expect(TerminalPlace.safeParse({ repo: null, task: null, cwd: "/" }).success).toBe(false);
  });
});
