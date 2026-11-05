import { describe, expect, test } from "bun:test";
import { restartOnModelNote } from "../src/lib/model-change.ts";

describe("restarting a session on another model (ADR-206)", () => {
  test("the note says who keeps the model: the task, the session or the supervisor's Settings", () => {
    expect(restartOnModelNote({ supervisor: false, task: "t1" })).toBe(
      "The session stops and starts again on this model with the same conversation. The task keeps it for its later resumes.",
    );
    expect(restartOnModelNote({ supervisor: false, task: null })).toEndWith("The session keeps it for its later restarts.");
    expect(restartOnModelNote({ supervisor: true, task: null })).toEndWith("It becomes the supervisor model in Settings.");
  });
});
