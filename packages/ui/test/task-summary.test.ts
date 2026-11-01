import { describe, expect, test } from "bun:test";
import { summaryToggleLabel } from "../src/lib/task-summary.ts";

describe("the task summary's button", () => {
  test("a short summary without check steps has no button", () => {
    expect(summaryToggleLabel(false, false, 0)).toBeNull();
  });

  test("check steps under a short summary are behind How to check, so they show only when asked for", () => {
    expect(summaryToggleLabel(false, false, 2)).toBe("How to check");
  });

  test("a cut summary opens with Show all, with or without steps, and an open one closes with Show less", () => {
    expect(summaryToggleLabel(false, true, 0)).toBe("Show all");
    expect(summaryToggleLabel(false, true, 2)).toBe("Show all");
    expect(summaryToggleLabel(true, true, 2)).toBe("Show less");
    expect(summaryToggleLabel(true, false, 0)).toBe("Show less");
  });
});
