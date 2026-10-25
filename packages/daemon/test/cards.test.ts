import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepoCard } from "@trackwall/protocol";
import { CardCache } from "../src/modules/cards/card-cache.ts";
import { Cards } from "../src/modules/cards/cards.ts";
import { Vcs } from "../src/modules/vcs/vcs.ts";
import { Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";
import { fakeHosting } from "./support/hosting.ts";

/** The `cards` module on real git and a projects folder, with the card cache in a temporary directory. */
async function setup(vcs: Vcs = new Vcs()) {
  const home = mkdtempSync(join(tmpdir(), "trackwall-home-"));
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
  const file = new WorkspaceFile(join(home, "workspace.yaml"));
  const workspace = new Workspace({ file, vcs, hosting: fakeHosting().hosting, openEditor: () => {}, openFolder: () => {} });
  await workspace.setProjectsDir(projects);
  const cardsDir = join(home, "cards");
  const cards = new Cards({ vcs, repos: workspace, cache: new CardCache(cardsDir, () => {}) });
  return { home, projects, cardsDir, cards, workspace };
}

const PACKAGE_JSON = JSON.stringify({ name: "web", private: true, dependencies: { react: "19.1.0" } }, null, 2);

describe("cards", () => {
  test("the card reads files from the HEAD commit, not from the working directory", async () => {
    const { projects, cards } = await setup();
    const repo = makeRepo({ "package.json": PACKAGE_JSON, "mise.toml": '[tools]\nnode = "22"\n' }, "web", projects);
    // An uncommitted change does not reach the card (ADR-14).
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "web", dependencies: { vue: "3" } }));

    const result = await cards.card("web");

    expect(result.card?.commit).toBe(gitIn(repo, "rev-parse", "HEAD").trim());
    expect(result.card?.consumes.map((c) => c.name)).toEqual(["react"]);
    expect(result.card?.tools.map((t) => [t.tool, t.version])).toEqual([["node", "22"]]);
    expect(result.card?.mise).toEqual({ configFiles: ["mise.toml"], tasks: [], complete: true });
    expect(result.tags.map((t) => t.name)).toEqual(["frontend", "no-mise"]);
  });

  test("a card is computed once per commit and saved on disk, and a new commit gives a new card", async () => {
    const { projects, cards, cardsDir, workspace } = await setup();
    const repo = makeRepo({ "package.json": PACKAGE_JSON }, "web", projects);
    const first = await cards.card("web");
    expect(existsSync(join(cardsDir, `${first.card?.commit}.json`))).toBe(true);

    // A new instance (a daemon restart) with a git that cannot read files: the card must come from disk.
    const blind = new Vcs();
    blind.commitFiles = () => Promise.reject(new Error("should not read files"));
    const restarted = new Cards({ vcs: blind, repos: workspace, cache: new CardCache(cardsDir, () => {}) });
    expect((await restarted.card("web")).card).toEqual(first.card);

    commitFiles(repo, { "package.json": JSON.stringify({ name: "web", dependencies: { "@angular/core": "20" } }) }, "angular");
    const second = await cards.card("web");
    expect(second.card?.commit).not.toBe(first.card?.commit);
    expect(second.card?.mechanisms.map((m) => m.id)).toEqual(["angular"]);
  });

  test("a card that depends on the time of computing (persist: false) stays only in memory, and a restart computes it again", async () => {
    const cardsDir = join(mkdtempSync(join(tmpdir(), "trackwall-home-")), "cards");
    const commit = "b".repeat(40);
    const card: RepoCard = {
      commit,
      buildFiles: [],
      provides: [],
      consumes: [],
      dtos: [],
      tools: [],
      mise: { configFiles: [], tasks: [], complete: true },
      mechanisms: [],
      problems: [],
    };
    const cache = new CardCache(cardsDir, () => {});
    expect(await cache.getOrCompute(commit, async () => ({ card, persist: false }))).toEqual(card);
    expect(await cache.getOrCompute(commit, () => Promise.reject(new Error("the card is in memory")))).toEqual(card);
    expect(existsSync(join(cardsDir, `${commit}.json`))).toBe(false);
    const restarted = new CardCache(cardsDir, () => {});
    const recomputed = { ...card, problems: [{ path: "", message: "computed again" }] };
    expect(await restarted.getOrCompute(commit, async () => ({ card: recomputed, persist: true }))).toEqual(recomputed);
  });

  test("concurrent requests for the card of the same commit (the tag list and the card at once) read git once", async () => {
    const vcs = new Vcs();
    let reads = 0;
    const commitFilesOf = vcs.commitFiles.bind(vcs);
    vcs.commitFiles = (...args) => {
      reads++;
      return commitFilesOf(...args);
    };
    const { projects, cards } = await setup(vcs);
    makeRepo({ "package.json": PACKAGE_JSON }, "web", projects);
    const [card, tags] = await Promise.all([cards.card("web"), cards.tags()]);
    expect(reads).toBe(1);
    expect(tags).toEqual([{ kind: "ok", repo: "web", tags: card.tags }]);
  });

  test("a repo without commits has an empty card and tags only from the rules", async () => {
    const { projects, cards, home } = await setup();
    makeRepo({}, "fresh", projects);
    writeFileSync(join(home, "workspace.yaml"), `projectsDir: ${JSON.stringify(projects)}\nrepoTags:\n  sandbox: ["fre*"]\n`);

    expect(await cards.card("fresh")).toEqual({
      repo: "fresh",
      card: null,
      tags: [{ name: "sandbox", reason: "repoTags rule in workspace.yaml: fre*" }],
    });
  });

  test("mise tasks from conf.d and a task directory in the commit remove the no-mise tag", async () => {
    const { projects, cards } = await setup();
    makeRepo({ ".config/mise/conf.d/ci.toml": 'tasks.ci = "make ci"\n', "mise-tasks/dev": "#!/bin/sh\n" }, "web", projects);

    const result = await cards.card("web");

    expect(result.card?.mise.tasks.map((t) => t.name)).toEqual(["ci", "dev"]);
    expect(result.tags.map((t) => t.name)).not.toContain("no-mise");
  });

  test("tags of every listed repo; a repo git cannot read has a reason instead of tags", async () => {
    const { projects, cards } = await setup();
    makeRepo({ "pom.xml": "<project><groupId>g</groupId><artifactId>lib</artifactId></project>" }, "lib", projects);
    mkdirSync(join(projects, "zepsute", ".git"), { recursive: true });

    const tags = await cards.tags();

    expect(tags.map((t) => (t.kind === "ok" ? [t.repo, t.tags.map((x) => x.name)] : [t.repo, t.kind]))).toEqual([
      ["lib", ["java", "library", "no-mise"]],
      ["zepsute", "unavailable"],
    ]);
  });

  test("an unknown repo is not_found, and a repo git cannot read is repo_unavailable", async () => {
    const { projects, cards } = await setup();
    mkdirSync(join(projects, "zepsute", ".git"), { recursive: true });
    await expect(cards.card("missing")).rejects.toMatchObject({ code: "not_found" });
    await expect(cards.card("zepsute")).rejects.toMatchObject({ code: "repo_unavailable" });
  });
});
