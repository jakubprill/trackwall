import { describe, expect, test } from "bun:test";
import { SessionAttention } from "../src/modules/agents/session-attention.ts";

const AT = "2026-11-13T12:00:00.000Z";

describe("waiting for you (ADR-47)", () => {
  test("a session without a state does not wait for you", () => {
    expect(new SessionAttention().waiting(undefined)).toBe(false);
  });

  test("Input waits for you until a window comes in front of the user", () => {
    const attention = new SessionAttention();
    attention.changed("Working", "Input", AT);
    expect(attention.waiting("Input")).toBe(true);

    attention.window().focus(true);

    expect(attention.waiting("Input")).toBe(false);
  });

  test("Input waits for you until the user types into the session", () => {
    const attention = new SessionAttention();
    attention.changed(undefined, "Input", AT);

    attention.typed();

    expect(attention.waiting("Input")).toBe(false);
  });

  test("Error, a turn that failed, waits for you until the user has seen it (ADR-243)", () => {
    const attention = new SessionAttention();
    attention.changed("Working", "Error", AT);
    expect(attention.waiting("Error")).toBe(true);

    attention.window().focus(true);

    expect(attention.waiting("Error")).toBe(false);
  });

  test("Approval and Plan wait for an answer even in a window in front of the user", () => {
    const attention = new SessionAttention();
    attention.window().focus(true);
    attention.changed("Working", "Approval", AT);
    expect(attention.waiting("Approval")).toBe(true);
    attention.changed("Approval", "Plan", AT);
    expect(attention.waiting("Plan")).toBe(true);
  });

  test("a turn that ends while a window is in front of the user is seen at once", () => {
    const attention = new SessionAttention();
    attention.window().focus(true);

    attention.changed("Working", "Input", AT);

    expect(attention.waiting("Input")).toBe(false);
  });

  test("a turn that ends after the window left waits for you again, although the previous one was seen", () => {
    const attention = new SessionAttention();
    const window = attention.window();
    window.focus(true);
    attention.changed("Working", "Input", AT);
    window.focus(false);

    attention.changed("Input", "Working", AT);
    attention.changed("Working", "Input", AT);

    expect(attention.waiting("Input")).toBe(true);
  });

  test("a closed window no longer counts as in front of the user", () => {
    const attention = new SessionAttention();
    const window = attention.window();
    window.focus(true);

    window.close();
    attention.changed("Working", "Input", AT);

    expect(attention.waiting("Input")).toBe(true);
  });

  test("a stronger source confirming the seen Input does not make it wait again", () => {
    const attention = new SessionAttention();
    attention.changed("Working", "Input", AT);
    attention.typed();

    attention.changed("Input", "Input", AT);

    expect(attention.waiting("Input")).toBe(false);
  });

  test("the session counts as watched while any of its windows is in front of the user", () => {
    const attention = new SessionAttention();
    const first = attention.window();
    const second = attention.window();
    first.focus(true);
    second.focus(true);
    first.focus(false);

    attention.changed("Working", "Input", AT);

    expect(attention.waiting("Input")).toBe(false);
  });

  test("waits for you since the change into the state, which a source confirming the state does not move (ADR-247)", () => {
    const attention = new SessionAttention();
    attention.changed("Working", "Approval", "2026-11-13T12:00:00.000Z");

    attention.changed("Approval", "Approval", "2026-11-13T12:07:00.000Z");

    expect(attention.waitingSince("Approval")).toBe("2026-11-13T12:00:00.000Z");
  });

  test("a new wait starts its own time", () => {
    const attention = new SessionAttention();
    attention.changed("Working", "Approval", "2026-11-13T12:00:00.000Z");
    attention.changed("Approval", "Working", "2026-11-13T12:01:00.000Z");

    attention.changed("Working", "Input", "2026-11-13T12:30:00.000Z");

    expect(attention.waitingSince("Input")).toBe("2026-11-13T12:30:00.000Z");
  });

  test("a session that does not wait has no waiting time", () => {
    const attention = new SessionAttention();
    attention.changed("Approval", "Working", AT);
    expect(attention.waitingSince("Working")).toBeNull();

    attention.changed("Working", "Input", AT);
    attention.typed();

    expect(attention.waitingSince("Input")).toBeNull();
  });
});
