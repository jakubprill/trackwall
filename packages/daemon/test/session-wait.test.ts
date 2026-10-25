import { describe, expect, test } from "bun:test";
import type { WaitStatus } from "@trackwall/protocol";
import { outcome, waitUntilSettled } from "../src/modules/agents/session-wait.ts";

describe("waiting for a session", () => {
  test("the wait lasts while the state is in progress, and ends at the first state that needs someone", async () => {
    const states: WaitStatus[] = ["starting", "working", "needs_attention", "working"];
    let reads = 0;
    const result = await waitUntilSettled(() => outcome(states[reads++] ?? "working"), 5000, new AbortController().signal);
    expect(result.status).toBe("needs_attention");
    expect(reads).toBe(3);
  });

  test("after the time limit the wait returns the last in-progress state, not an error", async () => {
    const started = Date.now();
    const result = await waitUntilSettled(() => outcome("working"), 300, new AbortController().signal);
    expect(result.status).toBe("working");
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
  });

  test("a wait cancelled by the client ends at once with the state at the moment of cancelling", async () => {
    const abort = new AbortController();
    const started = Date.now();
    setTimeout(() => abort.abort(), 50);
    const result = await waitUntilSettled(() => outcome("proposal_pending"), 30_000, abort.signal);
    expect(result.status).toBe("proposal_pending");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
