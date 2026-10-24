import { describe, expect, test } from "bun:test";
import { SessionAttention } from "../src/modules/agents/session-attention.ts";

describe("waiting for you (ADR-47)", () => {
  test("a session without a state does not wait for you", () => {
    expect(new SessionAttention().waiting).toBe(false);
  });

  test("Input waits for you until a window comes in front of the user", () => {
    const attention = new SessionAttention();
    const window = {};
    attention.state("Working");
    attention.state("Input");
    expect(attention.waiting).toBe(true);

    attention.focus(window, true);

    expect(attention.waiting).toBe(false);
  });

  test("Input waits for you until the user types into the session", () => {
    const attention = new SessionAttention();
    attention.state("Input");

    attention.typed();

    expect(attention.waiting).toBe(false);
  });

  test("Approval and Plan wait for an answer even in a window in front of the user", () => {
    const attention = new SessionAttention();
    attention.focus({}, true);
    attention.state("Approval");
    expect(attention.waiting).toBe(true);
    attention.state("Plan");
    expect(attention.waiting).toBe(true);
  });

  test("a turn that ends while a window is in front of the user is seen at once", () => {
    const attention = new SessionAttention();
    attention.focus({}, true);
    attention.state("Working");

    attention.state("Input");

    expect(attention.waiting).toBe(false);
  });

  test("a turn that ends after the window left waits for you again, although the previous one was seen", () => {
    const attention = new SessionAttention();
    const window = {};
    attention.focus(window, true);
    attention.state("Input");
    attention.focus(window, false);

    attention.state("Working");
    attention.state("Input");

    expect(attention.waiting).toBe(true);
  });

  test("a stronger source confirming the seen Input does not make it wait again", () => {
    const attention = new SessionAttention();
    attention.state("Input");
    attention.typed();

    attention.state("Input");

    expect(attention.waiting).toBe(false);
  });

  test("the session counts as watched while any of its windows is in front of the user", () => {
    const attention = new SessionAttention();
    const first = {};
    const second = {};
    attention.focus(first, true);
    attention.focus(second, true);
    attention.focus(first, false);

    attention.state("Input");

    expect(attention.waiting).toBe(false);
  });
});
