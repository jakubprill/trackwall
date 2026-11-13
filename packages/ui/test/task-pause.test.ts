import { describe, expect, test } from "bun:test";
import { pausedNote, stoppedNote } from "../src/lib/task-pause.ts";

const now = new Date("2026-11-13T18:12:00Z");

describe("a paused task's words (ADR-251)", () => {
  test("the note says when the task was paused and that Resume starts the service it stopped again", () => {
    expect(pausedNote({ at: "2026-11-13T18:00:00Z", service: { lease: false } }, now)).toBe(
      "Paused 12 min ago. Resume goes on with its conversation and starts its service again.",
    );
  });

  test("a service that held the repo's port starts on it again, and without a service Resume only goes on", () => {
    expect(pausedNote({ at: "2026-11-13T18:00:00Z", service: { lease: true } }, now)).toBe(
      "Paused 12 min ago. Resume goes on with its conversation and starts its service again on the repo's port.",
    );
    expect(pausedNote({ at: "2026-11-13T18:11:50Z", service: null }, now)).toBe("Paused just now. Resume goes on with its conversation.");
  });

  test("what the pause stopped reads as one sentence, and nothing stopped says nothing", () => {
    expect(stoppedNote(["the session", "the service on port 41000", "mise task watch", "the shell"])).toBe(
      "Stopped the session, the service on port 41000, mise task watch and the shell.",
    );
    expect(stoppedNote(["the session"])).toBe("Stopped the session.");
    expect(stoppedNote([])).toBeNull();
  });
});
