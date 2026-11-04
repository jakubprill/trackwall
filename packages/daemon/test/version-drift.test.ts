import { describe, expect, test } from "bun:test";
import type { ConsumedPackage, RepoCard, ToolRequirement } from "@trackwall/protocol";
import type { GraphCardInput } from "../src/modules/graph/graph-input.ts";
import { versionDrift } from "../src/modules/graph/version-drift.ts";

function card(tools: ToolRequirement[], consumes: ConsumedPackage[] = []): RepoCard {
  return {
    commit: "a".repeat(40),
    buildFiles: [],
    provides: [],
    consumes,
    dtos: [],
    tools,
    mise: { configFiles: [], tasks: [], complete: true },
    mechanisms: [],
    reachTraced: false,
    problems: [],
  };
}

function repo(id: string, repoCard: RepoCard | null): GraphCardInput {
  return { kind: "ok", repo: id, remote: null, card: repoCard, tags: [] };
}

function tool(name: string, version: string, source: "mise" | "hint" = "mise", path = "mise.toml"): ToolRequirement {
  return { tool: name, version, source, evidence: { path, line: 2 } };
}

function maven(name: string, version: string | null, scope: string): ConsumedPackage {
  return { kind: "package", ecosystem: "maven", name, version, scope, evidence: { path: "pom.xml", line: 7 } };
}

describe("versionDrift", () => {
  test("Java is compared by its major version, however each repo writes it", () => {
    const drift = versionDrift([
      repo("a", card([tool("java", "1.8", "hint", "pom.xml")])),
      repo("b", card([tool("java", "corretto-8")])),
      repo("c", card([tool("java", "8.0.392-tem", "hint", ".sdkmanrc")])),
    ]);

    expect(drift).toEqual([]);
  });

  test("a repo's mise config wins over its hints, so a pom that says 17 under mise's 21 is not counted", () => {
    const drift = versionDrift([
      repo("a", card([tool("java", "21"), tool("java", "17", "hint", "pom.xml")])),
      repo("b", card([tool("java", "17", "hint", "pom.xml")])),
    ]);

    expect(drift.map((d) => [d.name, d.target, d.repos.map((r) => [r.repo, r.versions])])).toEqual([
      [
        "java",
        "21",
        [
          ["a", ["21"]],
          ["b", ["17"]],
        ],
      ],
    ]);
  });

  test("a repo whose modules disagree lists every version, and the drift shows even when another repo matches one", () => {
    const drift = versionDrift([
      repo("a", card([tool("java", "17", "hint", "api/pom.xml"), tool("java", "21", "hint", "worker/pom.xml")])),
      repo("b", card([tool("java", "21", "hint", "pom.xml")])),
    ]);

    expect(drift[0]?.repos).toEqual([
      {
        repo: "a",
        versions: ["17", "21"],
        evidence: [
          { path: "api/pom.xml", line: 2, detail: "java 17 (hint)" },
          { path: "worker/pom.xml", line: 2, detail: "java 21 (hint)" },
        ],
      },
      { repo: "b", versions: ["21"], evidence: [{ path: "pom.xml", line: 2, detail: "java 21 (hint)" }] },
    ]);
  });

  test("parent poms, imported BOMs and build plugins drift; plain dependencies and unsubstituted versions do not", () => {
    const drift = versionDrift([
      repo(
        "a",
        card(
          [],
          [
            maven("com.example:company-parent", "4.1.0", "parent"),
            maven("org.springframework.cloud:spring-cloud-dependencies", "2023.0.3", "import"),
            maven("org.apache.maven.plugins:maven-surefire-plugin", "3.2.5", "plugin"),
            maven("com.fasterxml.jackson.core:jackson-databind", "2.17.0", "compile"),
            maven("org.jacoco:jacoco-maven-plugin", `\${jacoco.version}`, "plugin"),
          ],
        ),
      ),
      repo(
        "b",
        card(
          [],
          [
            maven("com.example:company-parent", "3.9.0", "parent"),
            maven("org.springframework.cloud:spring-cloud-dependencies", "2024.0.0", "import"),
            maven("org.apache.maven.plugins:maven-surefire-plugin", "3.5.1", "plugin"),
            maven("com.fasterxml.jackson.core:jackson-databind", "2.18.1", "compile"),
            maven("org.jacoco:jacoco-maven-plugin", "0.8.12", "plugin"),
          ],
        ),
      ),
    ]);

    expect(drift.map((d) => [d.kind, d.name, d.target])).toEqual([
      ["parent", "com.example:company-parent", "4.1.0"],
      ["parent", "org.springframework.cloud:spring-cloud-dependencies", "2024.0.0"],
      ["plugin", "org.apache.maven.plugins:maven-surefire-plugin", "3.5.1"],
    ]);
  });

  test("the Spring Boot parent, BOM and Gradle plugin are one subject, apart from parents and plugins", () => {
    const gradle: ConsumedPackage = {
      kind: "package",
      ecosystem: "gradle-plugin",
      name: "org.springframework.boot",
      version: "3.3.4",
      scope: "plugin",
      evidence: { path: "build.gradle.kts", line: 3 },
    };
    const drift = versionDrift([
      repo("a", card([], [maven("org.springframework.boot:spring-boot-starter-parent", "3.2.5", "parent")])),
      repo("b", card([], [maven("org.springframework.boot:spring-boot-dependencies", "3.3.4", "import")])),
      repo("c", card([], [gradle])),
    ]);

    expect(drift.map((d) => [d.kind, d.name, d.target, d.repos.map((r) => r.repo)])).toEqual([
      ["spring-boot", "spring-boot", "3.3.4", ["a", "b", "c"]],
    ]);
  });

  test("the target is the newest release, a release beats its own pre-release, and words give no target", () => {
    const boot = (version: string) => card([], [maven("org.springframework.boot:spring-boot-starter-parent", version, "parent")]);

    const numbered = versionDrift([repo("a", boot("3.4.0-RC1")), repo("b", boot("3.4.0")), repo("c", boot("3.10.1-SNAPSHOT"))]);
    const words = versionDrift([repo("a", card([tool("node", "lts")])), repo("b", card([tool("node", "latest")]))]);

    expect(numbered[0]?.target).toBe("3.10.1-SNAPSHOT");
    expect(versionDrift([repo("a", boot("3.4.0-RC1")), repo("b", boot("3.4.0"))])[0]?.target).toBe("3.4.0");
    expect(words.map((d) => [d.name, d.target])).toEqual([["node", null]]);
  });

  test("a tool only one repo has, a repo without commits and a repo git cannot read give no drift", () => {
    const drift = versionDrift([
      repo("a", card([tool("node", "22")])),
      repo("b", null),
      { kind: "unavailable", repo: "c", message: "not a git repository" },
    ]);

    expect(drift).toEqual([]);
  });

  test("tools come before Spring Boot, parents and plugins, each kind by name", () => {
    const drift = versionDrift([
      repo("a", card([tool("node", "20"), tool("java", "17")], [maven("org.apache.maven.plugins:maven-jar-plugin", "3.3.0", "plugin")])),
      repo("b", card([tool("node", "22"), tool("java", "21")], [maven("org.apache.maven.plugins:maven-jar-plugin", "3.4.2", "plugin")])),
    ]);

    expect(drift.map((d) => d.name)).toEqual(["java", "node", "org.apache.maven.plugins:maven-jar-plugin"]);
  });
});
