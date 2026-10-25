import { describe, expect, test } from "bun:test";
import { taskSlug } from "../src/modules/agents/task-branch.ts";

const ID = "3f2a9c1e-0000-4000-8000-000000000000";

describe("task branch name from the prompt", () => {
  test("the first words of the prompt without diacritics and the start of the identifier", () => {
    expect(taskSlug("Fix the naïve Łódź façade login button", ID)).toBe("fix-the-naive-lodz-facade-login-3f2a9c");
  });

  test("characters other than letters and digits only separate words, and a prompt without letters and digits gives a fallback name", () => {
    expect(taskSlug("--yolo: fix #42 (urgent!)", ID)).toBe("yolo-fix-42-urgent-3f2a9c");
    expect(taskSlug("??? 🚀", ID)).toBe("task-3f2a9c");
  });

  test("a first word longer than the limit is cut, not lost", () => {
    expect(taskSlug("a".repeat(50), ID)).toBe(`${"a".repeat(32)}-3f2a9c`);
  });
});
