import { describe, expect, test } from "bun:test";
import type { Service, SliceMember } from "@trackwall/protocol";
import { isServiceLive, leaseHolder, memberLabel, serviceLink, serviceStateLabel } from "../src/lib/service-state.ts";

const RUN = { kind: "running", runId: "r1", startedAt: "2026-10-24T10:00:00.000Z", pid: 42 } as const;
const service = (state: Service["state"], port: number | null = 8081): Service => ({
  repo: "orders",
  task: null,
  lease: false,
  state,
  port,
  portSource: port === null ? null : "log",
  run: RUN,
  since: RUN.startedAt,
  reason: null,
});
const member = (outcome: SliceMember["outcome"], problem: string | null = null): SliceMember => ({
  repo: "orders",
  task: null,
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

  test("the lease holder is the live task service with a lease in that repo, not a stopped one or another repo's", () => {
    const leased = { ...service("healthy"), task: "t1", lease: true };
    const stopped = { ...service("stopped"), task: "t2", lease: true };
    const elsewhere = { ...service("healthy"), repo: "bff", task: "t3", lease: true };

    expect(leaseHolder([service("stopped"), stopped, elsewhere, leased], "orders")).toBe(leased);
    expect(leaseHolder([service("healthy"), stopped], "orders")).toBeUndefined();
  });
});

describe("where a ready service opens in the browser (ADR-189)", () => {
  const TASK = "0f8fad5b-d9cb-469f-a165-70867728950e";

  test("through the daemon's service proxy when it runs one: the repo's name, or the task's before it", () => {
    const proxy = { desktop: false, serviceProxyPort: 7701 };
    expect(serviceLink(proxy, service("healthy"))).toBe("http://orders.localhost:7701/");
    expect(serviceLink(proxy, { ...service("healthy"), task: TASK })).toBe(`http://${TASK}.orders.localhost:7701/`);
  });

  test("at its port on this computer when the daemon runs here without the proxy", () => {
    expect(serviceLink({ desktop: true, serviceProxyPort: null }, service("healthy", 8081))).toBe("http://localhost:8081/");
  });

  test("nowhere while it is not ready, or from a daemon elsewhere without the proxy", () => {
    expect(serviceLink({ desktop: true, serviceProxyPort: 7701 }, service("starting"))).toBeUndefined();
    expect(serviceLink({ desktop: true, serviceProxyPort: null }, null)).toBeUndefined();
    expect(serviceLink({ desktop: false, serviceProxyPort: null }, service("healthy"))).toBeUndefined();
  });
});
