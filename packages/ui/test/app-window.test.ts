import { describe, expect, test } from "bun:test";
import { START_PARAMS, startFromLocation } from "../src/lib/app-window.ts";

const views = ["home", "repos", "sessions"] as const;

const layouts = ["1", "2", "4", "auto"] as const;

describe("what a window starts with", () => {
  test("an extra window starts with the view and session layout from its page address", () => {
    expect(startFromLocation("?view=sessions&sessionLayout=auto", START_PARAMS.view, views)).toBe("sessions");
    expect(startFromLocation("?view=sessions&sessionLayout=auto", START_PARAMS.sessionLayout, layouts)).toBe("auto");
  });

  test("the main window has nothing in its address and starts with the defaults", () => {
    expect(startFromLocation("", START_PARAMS.view, views)).toBeUndefined();
    expect(startFromLocation("", START_PARAMS.sessionLayout, layouts)).toBeUndefined();
  });

  test("an unknown value in the address is ignored", () => {
    expect(startFromLocation("?view=admin", START_PARAMS.view, views)).toBeUndefined();
    expect(startFromLocation("?view=", START_PARAMS.view, views)).toBeUndefined();
    expect(startFromLocation("?sessionLayout=9", START_PARAMS.sessionLayout, layouts)).toBeUndefined();
  });
});
