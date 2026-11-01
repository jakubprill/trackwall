import { describe, expect, test } from "bun:test";
import type { Routine } from "@trackwall/protocol";
import { readRoutineFile, routineNameOfFile, writeRoutineFile } from "../src/modules/routines/routine-file.ts";

const ROUTINE: Routine = {
  name: "update-orders-client",
  title: "Update the orders API client",
  repo: "shop",
  model: null,
  approvals: "ask",
  prompt: "Run the mise task update-client, then compile with tsgo.\n\nReport what changed with report_result.",
};

describe("a routine's file", () => {
  test("is frontmatter with the title, repo, model and approvals, and the prompt below it, and reads back as the same routine", () => {
    const text = writeRoutineFile(ROUTINE);
    expect(text).toBe(
      "---\ntitle: Update the orders API client\nrepo: shop\nmodel: null\napprovals: ask\n---\n" +
        "Run the mise task update-client, then compile with tsgo.\n\nReport what changed with report_result.\n",
    );
    expect(readRoutineFile("update-orders-client", text)).toEqual({ routine: ROUTINE });
  });

  test("takes its name from the file, never from a name or prompt the frontmatter sets", () => {
    const text = "---\nname: other\nprompt: hidden\ntitle: T\nrepo: shop\nmodel: null\napprovals: auto\n---\nThe visible prompt\n";
    expect(readRoutineFile("update-orders-client", text)).toEqual({
      routine: { name: "update-orders-client", title: "T", repo: "shop", model: null, approvals: "auto", prompt: "The visible prompt" },
    });
  });

  test("with a prompt that hides characters from the reader, is a problem, not a routine", () => {
    const text = writeRoutineFile(ROUTINE).replace("Report", "Report\u{E0041}");
    expect(readRoutineFile("update-orders-client", text)).toMatchObject({ problem: expect.stringContaining("invisible characters") });
  });

  test("without an approvals mode, is a problem: nothing about how a routine runs is left to a default", () => {
    const text = "---\ntitle: T\nrepo: shop\nmodel: null\n---\nprompt\n";
    expect(readRoutineFile("update-orders-client", text)).toMatchObject({ problem: expect.stringContaining("approvals") });
  });

  test("is named by a lowercase file name ending in .md; other files of the folder are not routines", () => {
    expect(routineNameOfFile("update-orders-client.md")).toBe("update-orders-client");
    expect(routineNameOfFile("Update.md")).toBeUndefined();
    expect(routineNameOfFile("notes.txt")).toBeUndefined();
    expect(routineNameOfFile("a--b.md")).toBeUndefined();
  });
});
