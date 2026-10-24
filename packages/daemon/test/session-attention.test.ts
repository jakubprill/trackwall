import { describe, expect, test } from "bun:test";
import { SessionAttention } from "../src/modules/agents/session-attention.ts";

describe("waiting for you (ADR-47)", () => {
  test("a session without a state does not wait for you", () => {
    expect(new SessionAttention().waiting(undefined)).toBe(false);
  });

  test("Input waits for you until a window comes in front of the user", () => {
    const attention = new SessionAttention();
    attention.changed("Working", "Input");
    expect(attention.waiting("Input")).toBe(true);

    attention.window().focus(true);

    expect(attention.waiting("Input")).toBe(false);
  });

  test("Input waits for you until the user types into the session", () => {
    const attention = new SessionAttention();
    attention.changed(undefined, "Input");

    attention.typed();

    expect(attention.waiting("Input")).toBe(false);
  });

  test("Approval and Plan wait for an answer even in a window in front of the user", () => {
    const attention = new SessionAttention();
    attention.window().focus(true);
    attention.changed("Working", "Approval");
    expect(attention.waiting("Approval")).toBe(true);
    attention.changed("Approval", "Plan");
    expect(attention.waiting("Plan")).toBe(true);
  });

  test("a turn that ends while a window is in front of the user is seen at once", () => {
    const attention = new SessionAttention();
    attention.window().focus(true);

    attention.changed("Working", "Input");

    expect(attention.waiting("Input")).toBe(false);
  });

  test("a turn that ends after the window left waits for you again, although the previous one was seen", () => {
    const attention = new SessionAttention();
    const window = attention.window();
    window.focus(true);
    attention.changed("Working", "Input");
    window.focus(false);

    attention.changed("Input", "Working");
    attention.changed("Working", "Input");

    expect(attention.waiting("Input")).toBe(true);
  });

  test("a closed window no longer counts as in front of the user", () => {
    const attention = new SessionAttention();
    const window = attention.window();
    window.focus(true);

    window.close();
    attention.changed("Working", "Input");

    expect(attention.waiting("Input")).toBe(true);
  });

  test("a stronger source confirming the seen Input does not make it wait again", () => {
    const attention = new SessionAttention();
    attention.changed("Working", "Input");
    attention.typed();

    attention.changed("Input", "Input");

    expect(attention.waiting("Input")).toBe(false);
  });

  test("the session counts as watched while any of its windows is in front of the user", () => {
    const attention = new SessionAttention();
    const first = attention.window();
    const second = attention.window();
    first.focus(true);
    second.focus(true);
    first.focus(false);

    attention.changed("Working", "Input");

    expect(attention.waiting("Input")).toBe(false);
  });
});
