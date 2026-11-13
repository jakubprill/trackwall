import { describe, expect, test } from "bun:test";
import {
  readTaskTemplateFile,
  TASK_TEMPLATE_FILE_FORMAT,
  writeTaskTemplateFile,
} from "../src/modules/task-templates/task-template-file.ts";

const TEMPLATE = {
  name: "check-a-flyway-migration",
  title: "Check a Flyway migration",
  prompt: "Read the migration <migration file>.\n\nSay whether it locks a large table.",
};

describe("a task template's file (ADR-251)", () => {
  test("is frontmatter with the title and the prompt below it, and reads back as the same template", () => {
    const text = writeTaskTemplateFile(TEMPLATE);
    expect(text).toBe(
      "---\ntitle: Check a Flyway migration\n---\nRead the migration <migration file>.\n\nSay whether it locks a large table.\n",
    );
    expect(readTaskTemplateFile("check-a-flyway-migration", text)).toEqual({ template: TEMPLATE });
  });

  test("takes its name from the file, never from a name or prompt the frontmatter sets", () => {
    const text = "---\nname: other\nprompt: hidden\ntitle: T\n---\nThe visible prompt\n";
    expect(readTaskTemplateFile("mine", text)).toEqual({ template: { name: "mine", title: "T", prompt: "The visible prompt" } });
  });

  test("with a prompt that hides characters from the reader, is a problem, not a template", () => {
    const text = writeTaskTemplateFile(TEMPLATE).replace("Say", "Say\u{E0041}");
    expect(readTaskTemplateFile("check-a-flyway-migration", text)).toMatchObject({
      problem: expect.stringContaining("invisible characters"),
    });
  });

  test("without a title or a prompt, is a problem", () => {
    expect(readTaskTemplateFile("x", "---\n{}\n---\nprompt\n")).toMatchObject({ problem: expect.stringContaining("title") });
    expect(readTaskTemplateFile("x", "---\ntitle: T\n---\n\n")).toMatchObject({ problem: expect.stringContaining("the prompt") });
  });

  test("is named by a lowercase file name ending in .md; other files of the folder are not templates", () => {
    expect(TASK_TEMPLATE_FILE_FORMAT.nameOfFile("fix-a-bug.md")).toBe("fix-a-bug");
    expect(TASK_TEMPLATE_FILE_FORMAT.nameOfFile("Fix.md")).toBeUndefined();
    expect(TASK_TEMPLATE_FILE_FORMAT.nameOfFile("notes.txt")).toBeUndefined();
  });
});
