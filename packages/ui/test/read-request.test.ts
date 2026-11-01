import { describe, expect, test } from "bun:test";
import type { ReadRequest, Session } from "@trackwall/protocol";
import { readRequestHold, shownReadRequest } from "../src/lib/read-request.ts";

const request = (waitsFor: ReadRequest["waitsFor"]): ReadRequest => ({
  prompt: "Trackwall has new messages for you: call get_messages",
  since: "2026-11-01T08:00:00.000Z",
  waitsFor,
});

describe("what the session panel says about what waits unread for the agent (ADR-159)", () => {
  test("Deliver now is offered only where nothing would send the prompt", () => {
    expect(readRequestHold(request("idle"))).toEqual({ text: "Nothing sends it until the next message", canDeliver: true });
  });

  test("not where the daemon sends it on its own or would send it into the user's text", () => {
    expect(readRequestHold(request("sent"))).toEqual({ text: "Sent to the agent, which has not read it yet", canDeliver: false });
    expect(readRequestHold(request("pending"))).toEqual({ text: "Goes to the agent as soon as it can take it", canDeliver: false });
    expect(readRequestHold(request("user_text"))).toEqual({
      text: "Waits for the text in the input box: send it or clear it",
      canDeliver: false,
    });
    expect(readRequestHold(request("dialog"))).toEqual({ text: "Waits until the agent's question is answered", canDeliver: false });
  });

  test("a session that no longer runs shows no read request", () => {
    const running = { run: { kind: "running", runId: "r", startedAt: "2026-11-01T08:00:00Z", pid: 1 }, readRequest: request("sent") };
    const exited = { ...running, run: { kind: "stopping", runId: "r", startedAt: "2026-11-01T08:00:00Z", pid: 1 } };

    expect(shownReadRequest(running as Session)).toEqual(request("sent"));
    expect(shownReadRequest(exited as Session)).toBeNull();
    expect(shownReadRequest(undefined)).toBeNull();
  });
});
