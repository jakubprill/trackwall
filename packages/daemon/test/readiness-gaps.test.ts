import { describe, expect, test } from "bun:test";
import type { MiseTask, MiseTasks, RepoCard } from "@trackwall/protocol";
import { readinessState } from "@trackwall/protocol";
import { repoGaps } from "../src/modules/readiness/repo-gaps.ts";

function task(name: string, origin: MiseTask["origin"] = "repo"): MiseTask {
  return { name, description: "", source: null, origin, usage: null, run: null };
}

function tasks(...list: MiseTask[]): MiseTasks {
  return { kind: "ok", tasks: list };
}

const BUILD_AND_TEST = tasks(task("build"), task("test"));

function card(overrides: Partial<RepoCard> = {}): RepoCard {
  return {
    commit: "a".repeat(40),
    buildFiles: [{ path: "pom.xml", tool: "maven", name: "orders-api", memberOf: null }],
    provides: [],
    consumes: [],
    dtos: [],
    tools: [],
    mise: { configFiles: [], tasks: [], complete: true },
    mechanisms: [],
    reachTraced: true,
    problems: [],
    ...overrides,
  };
}

describe("repoGaps: what blocks an agent", () => {
  test("a repo with build and test from its own mise config, a pinned tool and nothing else missing is ready", () => {
    const gaps = repoGaps({
      mise: BUILD_AND_TEST,
      card: {
        kind: "ok",
        card: card({ tools: [{ tool: "java", version: "21", source: "mise", evidence: { path: "mise.toml", line: 2 } }] }),
      },
      unresolvedCalls: 0,
    });

    expect(gaps).toEqual([]);
    expect(readinessState(gaps)).toBe("ready");
  });

  test("a repo without a mise task test is blocked, because Verify runs test", () => {
    const gaps = repoGaps({ mise: tasks(task("build"), task("lint")), card: { kind: "ok", card: card() }, unresolvedCalls: 0 });

    expect(gaps).toEqual([{ code: "no-build-test", message: "no mise task test" }]);
    expect(readinessState(gaps)).toBe("blocked");
  });

  test("the convention tasks do not count in a repo without a build file in its root, where they would fail", () => {
    const mise = tasks(task("setup", "convention"), task("build", "convention"), task("test", "convention"));

    expect(repoGaps({ mise, card: { kind: "ok", card: card({ buildFiles: [] }) }, unresolvedCalls: 0 })).toEqual([
      { code: "no-build-test", message: "the convention tasks find no pom.xml, build.gradle or package.json in the repo root" },
    ]);
    expect(repoGaps({ mise, card: { kind: "ok", card: card() }, unresolvedCalls: 0 })).toEqual([]);
  });

  test("an untrusted mise config, a missing mise and a mise error each block, with mise's first line as the reason", () => {
    const card0 = { kind: "ok" as const, card: card() };
    expect(repoGaps({ mise: { kind: "untrusted", message: "not trusted", running: [] }, card: card0, unresolvedCalls: 0 })).toEqual([
      { code: "mise-untrusted", message: "mise does not run this repo's tasks until you trust its config" },
    ]);
    expect(repoGaps({ mise: { kind: "not_installed", message: "", running: [] }, card: card0, unresolvedCalls: 0 })).toEqual([
      { code: "mise-missing", message: "mise is not installed, so no mise task can run" },
    ]);
    expect(
      repoGaps({ mise: { kind: "error", message: "mise ERROR invalid TOML\n  at line 3", running: [] }, card: card0, unresolvedCalls: 0 }),
    ).toEqual([{ code: "mise-failed", message: "mise ERROR invalid TOML" }]);
  });
});

describe("repoGaps: what weakens an agent, and what is only worth knowing", () => {
  test("a Spring Boot app without dev, Java only from pom.xml and two clients without a target are three gaps, in a fixed order", () => {
    const gaps = repoGaps({
      mise: BUILD_AND_TEST,
      card: {
        kind: "ok",
        card: card({
          provides: [
            { kind: "app", name: "orders-api", port: 8081, module: "", evidence: { path: "src/main/resources/application.yml", line: 3 } },
          ],
          tools: [{ tool: "java", version: "21", source: "hint", evidence: { path: "pom.xml", line: 9 } }],
        }),
      },
      unresolvedCalls: 2,
    });

    expect(gaps).toEqual([
      { code: "no-dev", message: "orders-api cannot start as a service: no mise task dev" },
      { code: "tool-unpinned", message: "not pinned in mise: java 21 from pom.xml" },
      { code: "unresolved-call", message: "2 HTTP clients without a repo to call in the list" },
    ]);
    expect(readinessState(gaps)).toBe("gaps");
  });

  test("a tool pinned in mise is not unpinned because pom.xml names it too", () => {
    const gaps = repoGaps({
      mise: BUILD_AND_TEST,
      card: {
        kind: "ok",
        card: card({
          tools: [
            { tool: "java", version: "21", source: "hint", evidence: { path: "pom.xml", line: 9 } },
            { tool: "java", version: "temurin-21", source: "mise", evidence: { path: "mise.toml", line: 2 } },
          ],
        }),
      },
      unresolvedCalls: 0,
    });

    expect(gaps).toEqual([]);
  });

  test("an incomplete card and a card not computed yet are worth knowing but leave the repo ready", () => {
    const incomplete = repoGaps({
      mise: BUILD_AND_TEST,
      card: { kind: "ok", card: card({ problems: [{ code: "no-endpoints", path: "", message: "no controller found" }] }) },
      unresolvedCalls: 0,
    });
    const pending = repoGaps({ mise: BUILD_AND_TEST, card: { kind: "ok", card: null }, unresolvedCalls: 0 });

    expect(incomplete).toEqual([{ code: "card-incomplete", message: "no controller found" }]);
    expect(pending).toEqual([{ code: "card-unavailable", message: "the card is still being computed" }]);
    expect(readinessState(incomplete)).toBe("ready");
    expect(readinessState(pending)).toBe("ready");
  });
});
