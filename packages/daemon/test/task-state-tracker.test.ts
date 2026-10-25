import { describe, expect, test } from "bun:test";
import { TaskStateTracker } from "../src/modules/agents/task-state-tracker.ts";

describe("combining task state signals", () => {
  test("a change carries the state, source, confidence, reason and time", () => {
    const tracker = new TaskStateTracker({ now: () => Date.UTC(2026, 9, 23, 12, 0, 0), staleAfterMs: 60_000 });

    expect(tracker.signal({ state: "Working", source: "osc", confidence: "high", reason: "osc 9;4;3" })).toEqual({
      state: "Working",
      source: "osc",
      confidence: "high",
      reason: "osc 9;4;3",
      at: "2026-10-23T12:00:00.000Z",
    });
  });

  test("the same state from the same source with the same confidence is not a change", () => {
    const tracker = new TaskStateTracker({ now: () => 0, staleAfterMs: 60_000 });
    tracker.signal({ state: "Working", source: "hook", confidence: "high", reason: "hook postToolUse" });

    expect(tracker.signal({ state: "Working", source: "hook", confidence: "high", reason: "hook userPromptSubmitted" })).toBeUndefined();
  });

  test("after the first hook terminal sequences no longer change the state", () => {
    const tracker = new TaskStateTracker({ now: () => 0, staleAfterMs: 60_000 });
    tracker.signal({ state: "Working", source: "osc", confidence: "high", reason: "osc 9;4;3" });
    tracker.signal({ state: "Approval", source: "hook", confidence: "medium", reason: "hook notification" });

    expect(tracker.signal({ state: "Input", source: "osc", confidence: "low", reason: "osc 9;4;0" })).toBeUndefined();
    expect(tracker.current?.state).toBe("Approval");
  });

  test("a human's key changes the state also after a hook, because hooks do not report an answer to an approval request", () => {
    const tracker = new TaskStateTracker({ now: () => 0, staleAfterMs: 60_000 });
    tracker.signal({ state: "Approval", source: "hook", confidence: "high", reason: "hook notification permission_prompt" });

    expect(tracker.keyboard({ state: "Working", source: "keyboard", confidence: "medium", reason: "key enter" })).toMatchObject({
      state: "Working",
      source: "keyboard",
    });
    // The key does not lower the source ranking: the progress bar still does not start work after a hook.
    tracker.signal({ state: "Input", source: "hook", confidence: "high", reason: "hook agentStop" });
    expect(tracker.signal({ state: "Working", source: "osc", confidence: "high", reason: "osc 9;4;3" })).toBeUndefined();
  });

  test("a weaker source can end Working when the end-of-turn hook did not come, but does not start work after a hook", () => {
    const tracker = new TaskStateTracker({ now: () => 0, staleAfterMs: 60_000 });
    tracker.signal({ state: "Working", source: "hook", confidence: "high", reason: "hook userPromptSubmitted" });

    expect(tracker.signal({ state: "Input", source: "osc", confidence: "low", reason: "osc 9;4;0" })).toMatchObject({
      state: "Input",
      source: "osc",
    });
    expect(tracker.signal({ state: "Working", source: "osc", confidence: "high", reason: "osc 9;4;3" })).toBeUndefined();
  });

  test("Working without output for longer than the threshold turns into Stale, and output restores Working", () => {
    let now = 0;
    const tracker = new TaskStateTracker({ now: () => now, staleAfterMs: 60_000 });
    tracker.signal({ state: "Working", source: "hook", confidence: "high", reason: "hook postToolUse" });

    now = 59_000;
    expect(tracker.tick()).toBeUndefined();
    now = 75_000;
    // The time and reason depend on the threshold, not on when `tick` is called.
    expect(tracker.tick()).toMatchObject({
      state: "Stale",
      source: "timeout",
      reason: "no output for 60 s",
      at: "1970-01-01T00:01:00.000Z",
    });
    now = 76_000;
    expect(tracker.activity()).toMatchObject({ state: "Working", source: "hook", reason: "hook postToolUse" });
  });

  test("waiting for a human does not turn into Stale, however long it lasts", () => {
    let now = 0;
    const tracker = new TaskStateTracker({ now: () => now, staleAfterMs: 60_000 });
    tracker.signal({ state: "Approval", source: "hook", confidence: "medium", reason: "hook notification" });

    now = 3_600_000;
    expect(tracker.tick()).toBeUndefined();
  });

  test("the exit code decides Done or Error when the hook did not report the end of the session", () => {
    const ok = new TaskStateTracker({ now: () => 0, staleAfterMs: 60_000 });
    ok.signal({ state: "Input", source: "hook", confidence: "high", reason: "hook agentStop" });
    expect(ok.exit(0)).toMatchObject({ state: "Done", source: "exit", confidence: "exact", reason: "exit code 0" });

    const crashed = new TaskStateTracker({ now: () => 0, staleAfterMs: 60_000 });
    crashed.signal({ state: "Working", source: "osc", confidence: "high", reason: "osc 9;4;3" });
    expect(crashed.exit(1)).toMatchObject({ state: "Error", source: "exit", reason: "exit code 1" });
  });

  test("an error from a hook without an end of session does not win over exit code 0", () => {
    const tracker = new TaskStateTracker({ now: () => 0, staleAfterMs: 60_000 });
    tracker.signal({ state: "Error", source: "hook", confidence: "medium", reason: "hook errorOccurred" });

    expect(tracker.exit(0)).toMatchObject({ state: "Done", source: "exit" });
  });

  test("the end of session from a hook stays after the process exits, and after that nothing changes the state", () => {
    const tracker = new TaskStateTracker({ now: () => 0, staleAfterMs: 60_000 });
    tracker.signal({ state: "Done", source: "hook", confidence: "high", reason: "hook sessionEnd user_exit", endsSession: true });

    expect(tracker.exit(0)).toBeUndefined();
    expect(tracker.signal({ state: "Working", source: "hook", confidence: "high", reason: "hook postToolUse" })).toBeUndefined();
    expect(tracker.current).toMatchObject({ state: "Done", reason: "hook sessionEnd user_exit" });
  });
});
