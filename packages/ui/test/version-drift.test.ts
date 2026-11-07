import { describe, expect, test } from "bun:test";
import type { VersionDrift } from "@trackwall/protocol";
import { initialParts } from "../src/lib/change-start.ts";
import { alignPart, alignPrompt, alignTitle, driftSubject, repoDrift, reposToAlign } from "../src/lib/version-drift.ts";

const BILLING = {
  repo: "billing",
  versions: ["17", "21"],
  evidence: [
    { path: "api/pom.xml", line: 9, detail: "java 17 (hint)" },
    { path: "worker/pom.xml", line: 9, detail: "java 21 (hint)" },
  ],
};

const JAVA: VersionDrift = {
  kind: "tool",
  name: "java",
  target: "21",
  repos: [
    { repo: "orders", versions: ["17"], evidence: [{ path: "pom.xml", line: 9, detail: "java 17 (hint)" }] },
    { repo: "payments", versions: ["21"], evidence: [{ path: "mise.toml", line: 2, detail: "java 21 (mise)" }] },
    BILLING,
  ],
};

const SUREFIRE: VersionDrift = {
  kind: "plugin",
  name: "org.apache.maven.plugins:maven-surefire-plugin",
  target: "3.5.1",
  repos: [
    { repo: "orders", versions: ["3.2.5"], evidence: [{ path: "pom.xml", line: 40, detail: "maven-surefire-plugin 3.2.5 (plugin)" }] },
    { repo: "payments", versions: ["3.5.1"], evidence: [{ path: "pom.xml", line: 52, detail: "maven-surefire-plugin 3.5.1 (plugin)" }] },
  ],
};

describe("version drift in the Overview view", () => {
  test("a subject reads as a person writes it: the tool's name, Spring Boot, or a package's artifact", () => {
    expect(driftSubject(JAVA)).toBe("Java");
    expect(driftSubject({ kind: "spring-boot", name: "spring-boot" })).toBe("Spring Boot");
    expect(driftSubject({ kind: "tool", name: "pnpm" })).toBe("pnpm");
    expect(driftSubject(SUREFIRE)).toBe("maven-surefire-plugin");
  });

  test("the repos to align are the ones with any version other than the target, also a repo whose modules disagree", () => {
    expect(reposToAlign(JAVA).map((r) => r.repo)).toEqual(["orders", "billing"]);
  });

  test("the form starts with at most six of the repos to align, a change's limit", () => {
    const many: VersionDrift = {
      ...SUREFIRE,
      repos: Array.from({ length: 8 }, (_, i) => ({
        repo: `repo-${i}`,
        versions: [i === 0 ? "3.5.1" : "3.2.5"],
        evidence: [{ path: "pom.xml", line: 1, detail: "" }],
      })),
    };

    expect(initialParts(reposToAlign(many)).map((r) => r.repo)).toEqual(["repo-1", "repo-2", "repo-3", "repo-4", "repo-5", "repo-6"]);
  });

  test("the change is titled by the subject and target, and each part says what its repo has and where", () => {
    expect(alignTitle(JAVA)).toBe("Align Java to 21");
    expect(alignPrompt(SUREFIRE)).toStartWith(
      "Move this repo to org.apache.maven.plugins:maven-surefire-plugin (build plugin) 3.5.1, the newest version other repos",
    );
    expect(alignPart(BILLING)).toEqual({
      repo: "billing",
      note: "it uses 17, 21 at api/pom.xml:9: java 17 (hint), worker/pom.xml:9: java 21 (hint)",
    });
  });

  test("a repo's drifts are the ones it is part of, each with the repo's own versions", () => {
    expect(repoDrift({ drift: [JAVA, SUREFIRE] }, "billing")).toEqual([{ drift: JAVA, own: BILLING }]);
    expect(repoDrift({ drift: [JAVA, SUREFIRE] }, "orders").map(({ drift, own }) => [drift.name, own.versions])).toEqual([
      ["java", ["17"]],
      [SUREFIRE.name, ["3.2.5"]],
    ]);
  });
});
