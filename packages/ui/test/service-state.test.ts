import { describe, expect, test } from "bun:test";
import type { Service, SliceMember } from "@trackwall/protocol";
import { isServiceLive, memberLabel, serviceStateLabel } from "../src/lib/service-state.ts";

const RUN = { kind: "running", runId: "r1", startedAt: "2026-10-24T10:00:00.000Z", pid: 42 } as const;
const service = (state: Service["state"], port: number | null = 8081): Service => ({
  repo: "orders",
  state,
  port,
  portSource: port === null ? null : "log",
  run: RUN,
  since: RUN.startedAt,
  reason: null,
});
const member = (outcome: SliceMember["outcome"], problem: string | null = null): SliceMember => ({
  repo: "orders",
  calledBy: [{ repo: "bff", key: "orders" }],
  outcome,
  service: null,
  problem,
  errors: [],
});

describe("service state in the UI", () => {
  test("a ready service shows its port, a crash and a closed port are errors", () => {
    expect(serviceStateLabel(service("healthy"))).toEqual({ tone: "ok", label: "ready on port 8081" });
    expect(serviceStateLabel(service("healthy", null))).toEqual({ tone: "ok", label: "ready" });
    expect(serviceStateLabel(service("crashed"))).toEqual({ tone: "error", label: "crashed" });
    expect(serviceStateLabel(service("unhealthy"))).toEqual({ tone: "error", label: "not answering" });
    expect(serviceStateLabel(null)).toEqual({ label: "not started" });
  });

  test("a dependency is skipped with its reason, waits until its service is known, then shows its live state", () => {
    expect(memberLabel(member("skipped", "no mise task dev"), null)).toEqual({ label: "skipped: no mise task dev" });
    expect(memberLabel(member("pending"), null)).toEqual({ tone: "warning", label: "waiting for its dependencies" });
    expect(memberLabel(member("pending"), service("starting"))).toEqual({ tone: "warning", label: "starting" });
  });

  test("only a stopped or crashed service has a Start button", () => {
    expect(["starting", "healthy", "unhealthy", "stopping"].every((s) => isServiceLive(service(s as Service["state"])))).toBe(true);
    expect(isServiceLive(service("stopped")) || isServiceLive(service("crashed")) || isServiceLive(null)).toBe(false);
  });
});
