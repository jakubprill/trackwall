import { describe, expect, test } from "bun:test";
import { viewFromLocation } from "../src/lib/app-window.ts";

const views = ["home", "repos", "sessions"] as const;

describe("the view a window starts with", () => {
  test("an extra window starts with the view from its page address", () => {
    expect(viewFromLocation("?view=sessions", views)).toBe("sessions");
  });

  test("the main window has no view in its address and starts with the default view", () => {
    expect(viewFromLocation("", views)).toBeUndefined();
  });

  test("an unknown view in the address is ignored", () => {
    expect(viewFromLocation("?view=admin", views)).toBeUndefined();
    expect(viewFromLocation("?view=", views)).toBeUndefined();
  });
});
