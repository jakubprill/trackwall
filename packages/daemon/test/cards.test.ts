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

/** Moduł `cards` na prawdziwym gicie i folderze z projektami, z pamięcią kart w katalogu tymczasowym. */
async function setup(vcs: Vcs = new Vcs()) {
  const home = mkdtempSync(join(tmpdir(), "trackwall-home-"));
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projekty-"));
  const file = new WorkspaceFile(join(home, "workspace.yaml"));
  const workspace = new Workspace({ file, vcs, hosting: fakeHosting().hosting, openEditor: () => {}, openFolder: () => {} });
  await workspace.setProjectsDir(projects);
  const cardsDir = join(home, "cards");
  const cards = new Cards({ vcs, repos: workspace, cache: new CardCache(cardsDir, () => {}) });
  return { home, projects, cardsDir, cards, workspace };
}

const PACKAGE_JSON = JSON.stringify({ name: "web", private: true, dependencies: { react: "19.1.0" } }, null, 2);

describe("cards", () => {
  test("karta czyta pliki z commita HEAD, nie z katalogu roboczego", async () => {
    const { projects, cards } = await setup();
    const repo = makeRepo({ "package.json": PACKAGE_JSON, "mise.toml": '[tools]\nnode = "22"\n' }, "web", projects);
    // Niezacommitowana zmiana nie trafia na kartę (ADR-14).
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "web", dependencies: { vue: "3" } }));

    const result = await cards.card("web");

    expect(result.card?.commit).toBe(gitIn(repo, "rev-parse", "HEAD").trim());
    expect(result.card?.consumes.map((c) => c.name)).toEqual(["react"]);
    expect(result.card?.tools.map((t) => [t.tool, t.version])).toEqual([["node", "22"]]);
    expect(result.card?.mise).toEqual({ configFiles: ["mise.toml"], tasks: [], complete: true });
    expect(result.tags.map((t) => t.name)).toEqual(["frontend", "no-mise"]);
  });

  test("karta jest liczona raz na commit i zapisana na dysku, a nowy commit daje nową kartę", async () => {
    const { projects, cards, cardsDir, workspace } = await setup();
    const repo = makeRepo({ "package.json": PACKAGE_JSON }, "web", projects);
    const first = await cards.card("web");
    expect(existsSync(join(cardsDir, `${first.card?.commit}.json`))).toBe(true);

    // Nowa instancja (restart daemona) z gitem, który nie umie czytać plików: karta musi przyjść z dysku.
    const blind = new Vcs();
    blind.commitFiles = () => Promise.reject(new Error("nie powinno czytać plików"));
    const restarted = new Cards({ vcs: blind, repos: workspace, cache: new CardCache(cardsDir, () => {}) });
    expect((await restarted.card("web")).card).toEqual(first.card);

    commitFiles(repo, { "package.json": JSON.stringify({ name: "web", dependencies: { "@angular/core": "20" } }) }, "angular");
    const second = await cards.card("web");
    expect(second.card?.commit).not.toBe(first.card?.commit);
    expect(second.card?.mechanisms.map((m) => m.id)).toEqual(["angular"]);
  });

  test("karta zależna od czasu liczenia (persist: false) zostaje tylko w pamięci, a restart liczy ją od nowa", async () => {
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
    expect(await cache.getOrCompute(commit, () => Promise.reject(new Error("karta jest w pamięci")))).toEqual(card);
    expect(existsSync(join(cardsDir, `${commit}.json`))).toBe(false);
    const restarted = new CardCache(cardsDir, () => {});
    const recomputed = { ...card, problems: [{ path: "", message: "policzona od nowa" }] };
    expect(await restarted.getOrCompute(commit, async () => ({ card: recomputed, persist: true }))).toEqual(recomputed);
  });

  test("równoczesne pytania o kartę tego samego commita (lista tagów i karta naraz) czytają gita raz", async () => {
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

  test("repo bez commitów ma pustą kartę i tagi tylko z reguł", async () => {
    const { projects, cards, home } = await setup();
    makeRepo({}, "nowe", projects);
    writeFileSync(join(home, "workspace.yaml"), `projectsDir: ${JSON.stringify(projects)}\nrepoTags:\n  sandbox: ["now*"]\n`);

    expect(await cards.card("nowe")).toEqual({
      repo: "nowe",
      card: null,
      tags: [{ name: "sandbox", reason: "repoTags rule in workspace.yaml: now*" }],
    });
  });

  test("taski mise z conf.d i katalogu tasków w commicie zdejmują tag no-mise", async () => {
    const { projects, cards } = await setup();
    makeRepo({ ".config/mise/conf.d/ci.toml": 'tasks.ci = "make ci"\n', "mise-tasks/dev": "#!/bin/sh\n" }, "web", projects);

    const result = await cards.card("web");

    expect(result.card?.mise.tasks.map((t) => t.name)).toEqual(["ci", "dev"]);
    expect(result.tags.map((t) => t.name)).not.toContain("no-mise");
  });

  test("tagi każdego repo z listy; repo, którego git nie czyta, ma powód zamiast tagów", async () => {
    const { projects, cards } = await setup();
    makeRepo({ "pom.xml": "<project><groupId>g</groupId><artifactId>lib</artifactId></project>" }, "lib", projects);
    mkdirSync(join(projects, "zepsute", ".git"), { recursive: true });

    const tags = await cards.tags();

    expect(tags.map((t) => (t.kind === "ok" ? [t.repo, t.tags.map((x) => x.name)] : [t.repo, t.kind]))).toEqual([
      ["lib", ["java", "library", "no-mise"]],
      ["zepsute", "unavailable"],
    ]);
  });

  test("nieznane repo to not_found, a repo, którego git nie czyta, to repo_unavailable", async () => {
    const { projects, cards } = await setup();
    mkdirSync(join(projects, "zepsute", ".git"), { recursive: true });
    await expect(cards.card("nie-ma")).rejects.toMatchObject({ code: "not_found" });
    await expect(cards.card("zepsute")).rejects.toMatchObject({ code: "repo_unavailable" });
  });
});
