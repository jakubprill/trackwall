import { describe, expect, test } from "bun:test";
import { TaskStateTracker } from "../src/modules/agents/task-state-tracker.ts";

describe("łączenie sygnałów stanu zadania", () => {
  test("zmiana niesie stan, źródło, pewność, powód i czas", () => {
    const tracker = new TaskStateTracker({ now: () => Date.UTC(2026, 9, 23, 12, 0, 0), staleAfterMs: 60_000 });

    expect(tracker.signal({ state: "Working", source: "osc", confidence: "high", reason: "osc 9;4;3" })).toEqual({
      state: "Working",
      source: "osc",
      confidence: "high",
      reason: "osc 9;4;3",
      at: "2026-10-23T12:00:00.000Z",
    });
  });

  test("ten sam stan z tego samego źródła i z tą samą pewnością nie jest zmianą", () => {
    const tracker = new TaskStateTracker({ now: () => 0, staleAfterMs: 60_000 });
    tracker.signal({ state: "Working", source: "hook", confidence: "high", reason: "hook postToolUse" });

    expect(tracker.signal({ state: "Working", source: "hook", confidence: "high", reason: "hook userPromptSubmitted" })).toBeUndefined();
  });

  test("po pierwszym hooku sekwencje terminala nie zmieniają już stanu", () => {
    const tracker = new TaskStateTracker({ now: () => 0, staleAfterMs: 60_000 });
    tracker.signal({ state: "Working", source: "osc", confidence: "high", reason: "osc 9;4;3" });
    tracker.signal({ state: "Approval", source: "hook", confidence: "medium", reason: "hook notification" });

    expect(tracker.signal({ state: "Input", source: "osc", confidence: "low", reason: "osc 9;4;0" })).toBeUndefined();
    expect(tracker.current?.state).toBe("Approval");
  });

  test("słabsze źródło może zakończyć Working, gdy hook końca tury nie przyszedł, ale nie zaczyna pracy po hooku", () => {
    const tracker = new TaskStateTracker({ now: () => 0, staleAfterMs: 60_000 });
    tracker.signal({ state: "Working", source: "hook", confidence: "high", reason: "hook userPromptSubmitted" });

    expect(tracker.signal({ state: "Input", source: "osc", confidence: "low", reason: "osc 9;4;0" })).toMatchObject({
      state: "Input",
      source: "osc",
    });
    expect(tracker.signal({ state: "Working", source: "osc", confidence: "high", reason: "osc 9;4;3" })).toBeUndefined();
  });

  test("Working bez wyjścia dłużej niż próg przechodzi w Stale, a wyjście przywraca Working", () => {
    let now = 0;
    const tracker = new TaskStateTracker({ now: () => now, staleAfterMs: 60_000 });
    tracker.signal({ state: "Working", source: "hook", confidence: "high", reason: "hook postToolUse" });

    now = 59_000;
    expect(tracker.tick()).toBeUndefined();
    now = 75_000;
    // Czas i powód zależą od progu, nie od chwili wywołania `tick`.
    expect(tracker.tick()).toMatchObject({
      state: "Stale",
      source: "timeout",
      reason: "no output for 60 s",
      at: "1970-01-01T00:01:00.000Z",
    });
    now = 76_000;
    expect(tracker.activity()).toMatchObject({ state: "Working", source: "hook", reason: "hook postToolUse" });
  });

  test("czekanie na człowieka nie przechodzi w Stale, ile by nie trwało", () => {
    let now = 0;
    const tracker = new TaskStateTracker({ now: () => now, staleAfterMs: 60_000 });
    tracker.signal({ state: "Approval", source: "hook", confidence: "medium", reason: "hook notification" });

    now = 3_600_000;
    expect(tracker.tick()).toBeUndefined();
  });

  test("kod wyjścia rozstrzyga Done albo Error, gdy hook nie zgłosił końca sesji", () => {
    const ok = new TaskStateTracker({ now: () => 0, staleAfterMs: 60_000 });
    ok.signal({ state: "Input", source: "hook", confidence: "high", reason: "hook agentStop" });
    expect(ok.exit(0)).toMatchObject({ state: "Done", source: "exit", confidence: "exact", reason: "exit code 0" });

    const crashed = new TaskStateTracker({ now: () => 0, staleAfterMs: 60_000 });
    crashed.signal({ state: "Working", source: "osc", confidence: "high", reason: "osc 9;4;3" });
    expect(crashed.exit(1)).toMatchObject({ state: "Error", source: "exit", reason: "exit code 1" });
  });

  test("błąd z hooka bez końca sesji nie wygrywa z kodem wyjścia 0", () => {
    const tracker = new TaskStateTracker({ now: () => 0, staleAfterMs: 60_000 });
    tracker.signal({ state: "Error", source: "hook", confidence: "medium", reason: "hook errorOccurred" });

    expect(tracker.exit(0)).toMatchObject({ state: "Done", source: "exit" });
  });

  test("koniec sesji z hooka zostaje po wyjściu procesu, a potem nic już stanu nie zmienia", () => {
    const tracker = new TaskStateTracker({ now: () => 0, staleAfterMs: 60_000 });
    tracker.signal({ state: "Done", source: "hook", confidence: "high", reason: "hook sessionEnd user_exit", endsSession: true });

    expect(tracker.exit(0)).toBeUndefined();
    expect(tracker.signal({ state: "Working", source: "hook", confidence: "high", reason: "hook postToolUse" })).toBeUndefined();
    expect(tracker.current).toMatchObject({ state: "Done", reason: "hook sessionEnd user_exit" });
  });
});
