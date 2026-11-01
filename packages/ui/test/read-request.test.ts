import { describe, expect, test } from "bun:test";
import type { ReadRequest, Session } from "@trackwall/protocol";
import { readRequestHold, shownReadRequest } from "../src/lib/read-request.ts";

const request = (waitsFor: ReadRequest["waitsFor"]): ReadRequest => ({
  prompt: "Trackwall has new messages for you: call get_messages",
  since: "2026-11-01T08:00:00.000Z",
  waitsFor,
});

describe("what the session panel says about what waits unread for the agent (ADR-159)", () => {
  test("Deliver now is offered where it helps: a prompt not read, the user's text, or nothing that would send it", () => {
    expect(readRequestHold(request("sent")).canDeliver).toBe(true);
    expect(readRequestHold(request("user_text"))).toEqual({
      text: "Waits for your text in the input box: send it or clear it",
      canDeliver: true,
    });
    expect(readRequestHold(request("deliver_now")).canDeliver).toBe(true);
  });

  test("not in the middle of a turn or while the agent asks something, where the prompt goes in on its own", () => {
    expect(readRequestHold(request("turn_end"))).toEqual({
      text: "Goes to the agent with its next tool call or when its turn ends",
      canDeliver: false,
    });
    expect(readRequestHold(request("dialog")).canDeliver).toBe(false);
  });

  test("a session that no longer runs shows no read request", () => {
    const running = { run: { kind: "running", runId: "r", startedAt: "2026-11-01T08:00:00Z", pid: 1 }, readRequest: request("sent") };
    const exited = { ...running, run: { kind: "stopping", runId: "r", startedAt: "2026-11-01T08:00:00Z", pid: 1 } };

    expect(shownReadRequest(running as Session)).toEqual(request("sent"));
    expect(shownReadRequest(exited as Session)).toBeNull();
    expect(shownReadRequest(undefined)).toBeNull();
  });
});
