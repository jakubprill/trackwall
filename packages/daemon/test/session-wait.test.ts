import { describe, expect, test } from "bun:test";
import type { WaitStatus } from "@trackwall/protocol";
import { type WaitOutcome, waitUntilSettled } from "../src/modules/agents/session-wait.ts";

function outcome(status: WaitStatus): WaitOutcome {
  return { status, proposal: null, task: null, session: null, rejectionReason: null };
}

describe("czekanie na sesję", () => {
  test("czekanie trwa, dopóki stan jest w toku, i kończy się na pierwszym stanie, który wymaga kogoś", async () => {
    const states: WaitStatus[] = ["starting", "working", "needs_attention", "working"];
    let reads = 0;
    const result = await waitUntilSettled(() => outcome(states[reads++] ?? "working"), 5000, new AbortController().signal);
    expect(result.status).toBe("needs_attention");
    expect(reads).toBe(3);
  });

  test("po limicie czasu czekanie zwraca ostatni stan w toku, a nie błąd", async () => {
    const started = Date.now();
    const result = await waitUntilSettled(() => outcome("working"), 300, new AbortController().signal);
    expect(result.status).toBe("working");
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
  });

  test("przerwane przez klienta czekanie kończy się od razu ze stanem z chwili przerwania", async () => {
    const abort = new AbortController();
    const started = Date.now();
    setTimeout(() => abort.abort(), 50);
    const result = await waitUntilSettled(() => outcome("proposal_pending"), 30_000, abort.signal);
    expect(result.status).toBe("proposal_pending");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
