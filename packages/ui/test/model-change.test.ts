import { describe, expect, test } from "bun:test";
import { modelErrorNote, modelSwitchNote, restartOnModelNote } from "../src/lib/model-change.ts";

describe("restarting a session on another model (ADR-206)", () => {
  test("the note says who keeps the model: the task, the session or the supervisor's Settings", () => {
    expect(restartOnModelNote({ supervisor: false, task: "t1" })).toBe(
      "The session stops and starts again on this model with the same conversation. The task keeps it for its later resumes.",
    );
    expect(restartOnModelNote({ supervisor: false, task: null })).toEndWith("The session keeps it for its later restarts.");
    expect(restartOnModelNote({ supervisor: true, task: null })).toEndWith("It becomes the supervisor model in Settings.");
  });
});

describe("a session on another model than the one asked for (ADR-225)", () => {
  test("names the model Copilot CLI took and the one asked for", () => {
    expect(modelSwitchNote({ model: "claude-sonnet-5.5", modelInUse: "gpt-6-luna" })).toEqual({
      title: "Runs on gpt-6-luna, not claude-sonnet-5.5",
      detail:
        "Copilot CLI took another model without stopping: your account may not offer claude-sonnet-5.5, or /model switched it. " +
        "Model restarts the session on the one you choose.",
    });
  });

  test("says nothing when the models agree, when Trackwall asked for none or for auto, or before the log names one", () => {
    expect(modelSwitchNote({ model: "gpt-6-luna", modelInUse: "gpt-6-luna" })).toBeNull();
    expect(modelSwitchNote({ model: null, modelInUse: "gpt-6-luna" })).toBeNull();
    expect(modelSwitchNote({ model: "auto", modelInUse: "gpt-6-luna" })).toBeNull();
    expect(modelSwitchNote({ model: "claude-sonnet-5.5", modelInUse: null })).toBeNull();
  });
});

describe("a session whose latest model call failed (ADR-242)", () => {
  test("says what failed and points to Model", () => {
    expect(modelErrorNote({ model: "gpt-9", modelError: 'Execution failed: Model "gpt-9" is not available.' })).toEqual({
      title: "The model call failed",
      detail:
        'Copilot CLI: Execution failed: Model "gpt-9" is not available. If your account does not offer the model, Model restarts the session on a model other than gpt-9.',
    });
  });

  test("a session started without a model points to another model", () => {
    expect(modelErrorNote({ model: null, modelError: "429 rate limited" })?.detail).toBe(
      "Copilot CLI: 429 rate limited. If your account does not offer the model, Model restarts the session on another model.",
    );
  });

  test("says nothing while no call failed", () => {
    expect(modelErrorNote({ model: "gpt-9", modelError: null })).toBeNull();
  });
});
