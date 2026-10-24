import { describe, expect, test } from "bun:test";
import type { GraphEdge } from "@trackwall/protocol";
import { isStartedLine, portFromLine } from "../src/modules/services/readiness.ts";
import { planSlice } from "../src/modules/services/slice-plan.ts";

describe("the port and the start from a service log line", () => {
  test.each([
    [
      "2026-10-24 INFO 1 --- [main] o.s.b.w.embedded.tomcat.TomcatWebServer : Tomcat started on port 8081 (http) with context path '/'",
      8081,
    ],
    ["o.s.b.w.e.tomcat.TomcatWebServer : Tomcat started on port(s): 8082 (http) with context path ''", 8082],
    ["o.s.b.web.embedded.netty.NettyWebServer : Netty started on port 8083 (http)", 8083],
    ["  ➜  Local:   http://localhost:5173/", 5173],
    ["Server listening on http://127.0.0.1:3000", 3000],
    ["Listening on port 4000", 4000],
    ["Angular Live Development Server is listening on localhost:4200, open your browser on http://localhost:4200/", 4200],
  ])("%s gives port %d", (line, port) => {
    expect(portFromLine(line)).toBe(port);
  });

  test.each([
    "Started OrdersApplication in 4.2 seconds (process running for 4.9)",
    "Connecting to 127.0.0.1:5432",
    "Tomcat initialized with port 8080 (http)",
    "Tomcat started on port 99999 (http)",
    "Kafka consumer started, connected on localhost:9092",
  ])("%s gives no port", (line) => {
    expect(portFromLine(line)).toBeNull();
  });

  test("Spring Boot's Started line marks the start, a Tomcat line does not", () => {
    expect(isStartedLine("c.e.orders.OrdersApplication : Started OrdersApplication in 4.215 seconds (process running for 4.9)")).toBe(true);
    expect(isStartedLine("Tomcat started on port 8081 (http)")).toBe(false);
  });
});

function edge(from: string, to: string, kind: GraphEdge["kind"] = "http", confidence: GraphEdge["confidence"] = "high"): GraphEdge {
  return { from, to, kind, key: `${to}-app`, confidence, evidence: [{ repo: from, path: "a.yml", line: 1, detail: "calls" }] };
}

describe("the slice of a service", () => {
  test("dependencies over http and manual edges start in waves before the repo, packages and low edges do not count", () => {
    const plan = planSlice(
      [
        edge("bff", "orders"),
        edge("bff", "customers", "manual"),
        edge("orders", "config", "http", "exact"),
        edge("customers", "config", "http", "medium"),
        edge("bff", "commons", "package"),
        edge("bff", "maybe", "http", "low"),
        edge("other", "bff"),
      ],
      "bff",
    );

    expect(plan.waves).toEqual([["config"], ["orders", "customers"], ["bff"]]);
    expect(plan.calledBy.get("config")).toEqual([
      { repo: "orders", key: "config-app" },
      { repo: "customers", key: "config-app" },
    ]);
    expect(plan.calledBy.get("bff")).toEqual([]);
  });

  test("repos in a cycle start together after the ones they call", () => {
    const plan = planSlice([edge("a", "b"), edge("b", "a"), edge("b", "db")], "a");

    expect(plan.waves).toEqual([["db"], ["a", "b"]]);
  });

  test("a slice larger than the limit is refused", () => {
    const edges = Array.from({ length: 12 }, (_, i) => edge("root", `dep${i}`));

    expect(() => planSlice(edges, "root")).toThrow(/13 repos, more than 12/);
  });
});
