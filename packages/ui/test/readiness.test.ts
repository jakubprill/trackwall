import { describe, expect, test } from "bun:test";
import type { RepoReadiness } from "@trackwall/protocol";
import { gapFix, gapPart, readinessCounts, readinessGroups, readinessLine, repoGapFix } from "../src/lib/readiness.ts";

const REPOS: RepoReadiness[] = [
  { repo: "admin-web", state: "gaps", gaps: [{ code: "tool-unpinned", message: "not pinned in mise: node 22 from package.json" }] },
  {
    repo: "billing-api",
    state: "gaps",
    gaps: [
      { code: "no-dev", message: "billing-api cannot start as a service: no mise task dev" },
      { code: "tool-unpinned", message: "not pinned in mise: java 21 from pom.xml" },
    ],
  },
  { repo: "notify-worker", state: "blocked", gaps: [{ code: "no-build-test", message: "no mise task build or test" }] },
  { repo: "orders-api", state: "ready", gaps: [{ code: "card-incomplete", message: "no controller found" }] },
  { repo: "payments-api", state: "ready", gaps: [] },
];

describe("agent readiness in Overview", () => {
  test("each gap is listed once under its level, with every repo it is in and that repo's reason", () => {
    expect(readinessGroups(REPOS)).toEqual([
      { level: "blocks", gaps: [{ code: "no-build-test", repos: [{ repo: "notify-worker", message: "no mise task build or test" }] }] },
      {
        level: "weakens",
        gaps: [
          { code: "no-dev", repos: [{ repo: "billing-api", message: "billing-api cannot start as a service: no mise task dev" }] },
          {
            code: "tool-unpinned",
            repos: [
              { repo: "admin-web", message: "not pinned in mise: node 22 from package.json" },
              { repo: "billing-api", message: "not pinned in mise: java 21 from pom.xml" },
            ],
          },
        ],
      },
      { level: "info", gaps: [{ code: "card-incomplete", repos: [{ repo: "orders-api", message: "no controller found" }] }] },
    ]);
  });

  test("the count is of repos in each state, and an incomplete card leaves a repo ready", () => {
    expect(readinessCounts(REPOS)).toEqual({ ready: 2, gaps: 2, blocked: 1 });
  });

  test("missing build and test are fixed by the convention tasks while their file is absent, and by an agent once it is there", () => {
    expect(gapFix("no-build-test", "absent")).toBe("convention");
    expect(gapFix("no-build-test", "current")).toBe("agent");
    expect(gapFix("mise-untrusted", "absent")).toBe("repo");
    expect(gapFix("unresolved-call", "absent")).toBe("graph");
    expect(gapFix("mise-missing", "absent")).toBe("none");
  });

  test("a config mise would format is fixed by Format in every repo at once, and its problems by an agent", () => {
    expect(gapFix("mise-unformatted", "absent")).toBe("format");
    expect(gapFix("mise-invalid", "absent")).toBe("agent");
    expect(repoGapFix("mise-unformatted")).toBe("format");
    expect(repoGapFix("mise-invalid")).toBe("agent");
  });

  test("a task closing a gap ends its prompt with the gap as Trackwall found it in that repo", () => {
    expect(gapPart({ repo: "billing-api", message: "not pinned in mise: java 21 from pom.xml" })).toEqual({
      repo: "billing-api",
      note: "not pinned in mise: java 21 from pom.xml",
    });
  });
});

describe("agent readiness on a repo's card", () => {
  test("the line says ready, how many gaps weaken agents, or the first gap that blocks them", () => {
    expect(readinessLine(REPOS[3] as RepoReadiness)).toBe("ready");
    expect(readinessLine(REPOS[1] as RepoReadiness)).toBe("2 gaps");
    expect(readinessLine(REPOS[2] as RepoReadiness)).toBe("blocked: no build or test task");
  });

  test("a gap mise answers for opens the mise tasks tab, where the config is shown before it is trusted", () => {
    expect(repoGapFix("mise-untrusted")).toBe("mise");
    expect(repoGapFix("no-build-test")).toBe("mise");
    expect(repoGapFix("no-dev")).toBe("agent");
    expect(repoGapFix("unresolved-call")).toBe("none");
  });
});
