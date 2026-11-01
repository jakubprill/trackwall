import { describe, expect, test } from "bun:test";
import { ReadRequestClock } from "../src/modules/agents/read-request.ts";

describe("the clock of what waits unread for a session (ADR-159)", () => {
  test("since is when something began to wait, kept while it waits and started anew after a break", () => {
    const clock = new ReadRequestClock();
    clock.observe("read the review", Date.parse("2026-11-01T08:00:00.000Z"));
    clock.observe("read the review and the message", Date.parse("2026-11-01T08:00:05.000Z"));
    expect(clock.readRequest("read the review and the message", "pending", Date.parse("2026-11-01T08:00:07.000Z"))).toEqual({
      prompt: "read the review and the message",
      since: "2026-11-01T08:00:00.000Z",
      waitsFor: "pending",
    });

    clock.observe(undefined, Date.parse("2026-11-01T08:00:06.000Z"));
    clock.observe("read the updates", Date.parse("2026-11-01T08:01:00.000Z"));
    expect(clock.readRequest("read the updates", "idle", Date.parse("2026-11-01T08:01:30.000Z")).since).toBe("2026-11-01T08:01:00.000Z");
  });

  test("a prompt seen first between read cycles waits since it was seen", () => {
    const clock = new ReadRequestClock();

    expect(clock.readRequest("read the review", "sent", Date.parse("2026-11-01T09:00:00.000Z")).since).toBe("2026-11-01T09:00:00.000Z");
  });
});
