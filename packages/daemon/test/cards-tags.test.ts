import { describe, expect, test } from "bun:test";
import type { RepoCard } from "@trackwall/protocol";
import { globMatcher } from "../src/infra/glob.ts";
import { extractCard } from "../src/modules/cards/extract-card.ts";
import { loadSyntaxParsers } from "../src/modules/cards/syntax-tree.ts";
import { repoTags } from "../src/modules/cards/tags.ts";
import { snapshotOf } from "./support/snapshot.ts";

const parsers = await loadSyntaxParsers();

const SPRING_BFF_POM = `<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.3.0</version>
  </parent>
  <groupId>com.example</groupId>
  <artifactId>orders-bff</artifactId>
  <dependencies>
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-webflux</artifactId>
    </dependency>
    <dependency>
      <groupId>org.springframework.cloud</groupId>
      <artifactId>spring-cloud-starter-netflix-eureka-client</artifactId>
    </dependency>
  </dependencies>
</project>
`;

describe("repo tags", () => {
  const tagsOf = (card: RepoCard, id: string, remote: string | null = null, rules = {}) =>
    repoTags(card, { id, remote }, rules).map((t) => `${t.name}: ${t.reason}`);

  test("a BFF in Spring: java, backend and bff (from the name), each with a reason", () => {
    const card = extractCard(snapshotOf({ "pom.xml": SPRING_BFF_POM }), parsers);
    expect(tagsOf(card, "orders-bff")).toEqual([
      "backend: spring-boot in pom.xml:2",
      "bff: “bff” in the name orders-bff",
      "java: build file pom.xml",
      "no-mise: no mise config in the repo root",
    ]);
  });

  test("a frontend in TypeScript and a monorepo with workspace packages", () => {
    const card = extractCard(
      snapshotOf({
        "package.json": JSON.stringify({ name: "shop", private: true, workspaces: ["apps/*"], devDependencies: { typescript: "5" } }),
        "apps/web/package.json": JSON.stringify({ name: "web", private: true, dependencies: { react: "19" } }),
        "apps/admin/package.json": JSON.stringify({ name: "admin", private: true, dependencies: { vue: "3" } }),
      }),
      parsers,
    );
    expect(tagsOf(card, "shop")).toEqual([
      "frontend: react in apps/web/package.json:1",
      "monorepo: package.json lists 2 modules or packages",
      "no-mise: no mise config in the repo root",
      "typescript: typescript dependency in package.json:1",
    ]);
  });

  test("a library: provides a package without an app framework and deployment; separate builds in subdirectories are a monorepo", () => {
    const lib = extractCard(
      snapshotOf({ "pom.xml": "<project><groupId>com.example</groupId><artifactId>common-model</artifactId></project>" }),
      parsers,
    );
    expect(tagsOf(lib, "common-model")).toEqual([
      "java: build file pom.xml",
      "library: provides com.example:common-model and has no app framework or deployment files",
      "no-mise: no mise config in the repo root",
    ]);

    const split = extractCard(
      snapshotOf({ "backend/pom.xml": SPRING_BFF_POM, "frontend/package.json": JSON.stringify({ name: "front", private: true }) }),
      parsers,
    );
    expect(tagsOf(split, "app")).toContain("monorepo: separate builds in directories backend, frontend");
  });

  test("bff only as a separate word, not part of another", () => {
    const card = extractCard(snapshotOf({ "mise.toml": '[tasks.build]\nrun = "make"\n' }), parsers);
    expect(tagsOf(card, "bffcore")).toEqual([]);
    expect(tagsOf(card, "web_bff")).toEqual(["bff: “bff” in the name web_bff"]);
  });

  test("repoTags rules from workspace.yaml match the identifier or the remote address, ignoring case", () => {
    const rules = { "core-api": ["*-core"], payments: ["gitlab.example.com/Payments/**"] };
    const card = extractCard(snapshotOf({ "mise.toml": '[tasks.build]\nrun = "make"\n' }), parsers);
    expect(tagsOf(card, "billing-core", "gitlab.example.com/payments/billing", rules)).toEqual([
      "core-api: repoTags rule in workspace.yaml: *-core",
      "payments: repoTags rule in workspace.yaml: gitlab.example.com/Payments/**",
    ]);
    expect(repoTags(null, { id: "web", remote: null }, rules)).toEqual([]);
  });
});

describe("mise configuration and the no-mise tag", () => {
  test("mise tasks from [tasks] in the mise configuration and files in mise task directories, each with evidence", () => {
    const { mise } = extractCard(
      snapshotOf(
        {
          "mise.toml": '[tools]\nnode = "22"\n\n[tasks.build]\nrun = "pnpm build"\n\n[tasks."test:unit"]\nrun = "pnpm test"\n',
          ".config/mise.toml": '[tools]\nlint = "1"\n[tasks]\nlint = "pnpm lint"\n',
          ".config/mise/conf.d/ci.toml": 'tasks.ci = "pnpm ci"\n',
        },
        ["mise-tasks/dev", "mise-tasks/db/reset", "mise-tasks/test/_default", "mise-tasks/.gitkeep", "src/mise-tasks/no"],
      ),
      parsers,
    );
    expect(mise.configFiles).toEqual(["mise.toml", ".config/mise.toml", ".config/mise/conf.d/ci.toml"]);
    expect(mise.complete).toBe(true);
    expect(mise.tasks.map((t) => `${t.name} ${t.evidence.path}:${t.evidence.line}`)).toEqual([
      "build mise.toml:4",
      "test:unit mise.toml:7",
      "lint .config/mise.toml:4",
      "ci .config/mise/conf.d/ci.toml:1",
      "dev mise-tasks/dev:null",
      "db:reset mise-tasks/db/reset:null",
      "test mise-tasks/test/_default:null",
    ]);
  });

  test("a repo without mise configuration and a repo with a mise.toml without mise tasks get no-mise with a reason, and one with a mise task does not", () => {
    const noMise = (files: Record<string, string>, paths: string[] = []) =>
      repoTags(extractCard(snapshotOf(files, paths), parsers), { id: "app", remote: null }, {}).find((t) => t.name === "no-mise")?.reason;
    expect(noMise({})).toBe("no mise config in the repo root");
    expect(noMise({ "mise.toml": '[tools]\njava = "21"\n' })).toBe("mise.toml declares no tasks");
    expect(noMise({ "mise.toml": "[tools\n" })).toBe("mise.toml declares no tasks");
    expect(noMise({ "mise.toml": '[tasks]\nbuild = "make"\n' })).toBeUndefined();
    expect(noMise({}, [".mise/tasks/build"])).toBeUndefined();
    // A config file the card did not read (limits) may have mise tasks, so there is no tag.
    expect(noMise({}, ["mise.toml"])).toBeUndefined();
  });

  test("the no-mise reason points to mise.toml before other files, and a bad file from conf.d is a card problem", () => {
    const card = extractCard(
      snapshotOf({
        ".config/mise.toml": '[tools]\nnode = "22"\n',
        "mise.toml": '[tools]\njava = "21"\n',
        "mise/conf.d/broken.toml": "[tasks\n",
      }),
      parsers,
    );
    expect(card.mise.configFiles).toEqual(["mise.toml", ".config/mise.toml", "mise/conf.d/broken.toml"]);
    expect(repoTags(card, { id: "app", remote: null }, {}).find((t) => t.name === "no-mise")?.reason).toBe("mise.toml declares no tasks");
    expect(card.problems.map((p) => `${p.code} ${p.path}`)).toEqual(["file-invalid mise/conf.d/broken.toml"]);
  });
});

describe("glob", () => {
  test("* without a slash, ** with slashes or nothing, ? one character", () => {
    expect(globMatcher("packages/*")("packages/ui")).toBe(true);
    expect(globMatcher("packages/*")("packages/ui/x")).toBe(false);
    expect(globMatcher("packages/**")("packages/ui/x")).toBe(true);
    expect(globMatcher("a/**/b")("a/b")).toBe(true);
    expect(globMatcher("a/**/b")("a/x/y/b")).toBe(true);
    expect(globMatcher("a/**/b")("a/xb")).toBe(false);
    expect(globMatcher("a.b")("axb")).toBe(false);
    expect(globMatcher("v?")("v1")).toBe(true);
    expect(globMatcher("*-Core", { ignoreCase: true })("billing-core")).toBe(true);
  });
});
