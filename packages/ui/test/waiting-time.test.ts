import { describe, expect, test } from "bun:test";
import { waitingLabel, waitingSinceTitle } from "../src/lib/waiting-time.ts";

const now = new Date("2026-11-13T12:30:00Z");

describe("how long a session has waited for you (ADR-247)", () => {
  test("a session that waits shows the time since it began to wait", () => {
    expect(waitingLabel("2026-11-13T12:18:00Z", now)).toBe("12 min");
    expect(waitingLabel("2026-11-13T10:00:00Z", now)).toBe("2 h 30 min");
  });

  test("the first minute shows nothing, since the state says enough", () => {
    expect(waitingLabel("2026-11-13T12:29:30Z", now)).toBeUndefined();
  });

  test("a session that does not wait shows nothing", () => {
    expect(waitingLabel(null, now)).toBeUndefined();
  });

  test("the tooltip says since when, with the day only when it is not today", () => {
    const today = new Date(now.getTime() - 12 * 60_000);
    const yesterday = new Date(now.getTime() - 26 * 3_600_000);

    expect(waitingSinceTitle(today.toISOString(), now)).toBe(
      `Waiting for you since ${today.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`,
    );
    expect(waitingSinceTitle(yesterday.toISOString(), now)).toContain(
      yesterday.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
  });
});
