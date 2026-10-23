import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainError } from "../src/errors.ts";
import { Vcs } from "../src/modules/vcs/vcs.ts";
import { vscodeUrl, Workspace } from "../src/modules/workspace/workspace.ts";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";
import { makeRepo } from "./support/git-repo.ts";

function newWorkspace() {
  const file = join(mkdtempSync(join(tmpdir(), "pitwall-ws-")), "workspace.yaml");
  const opened: string[] = [];
  const workspace = new Workspace({ file: new WorkspaceFile(file), vcs: new Vcs(), openUrl: (url) => opened.push(url) });
  return { workspace, file, opened };
}

describe("workspace", () => {
  test("dodanie repo z podkatalogu zapisuje korzeń repo w workspace.yaml i zwraca jego stan", async () => {
    const { workspace, file } = newWorkspace();
    const dir = makeRepo({ "src/a.ts": "1" }, "Orders BFF");

    const repo = await workspace.add(join(dir, "src"));

    // realpath: tmpdir na macOS to dowiązanie do /private, a na Windowsie bywa krótką nazwą 8.3.
    expect(repo).toMatchObject({ id: "orders-bff", path: realpathSync.native(dir), status: { kind: "ok", branch: "main" } });
    expect(readFileSync(file, "utf8")).toContain("id: orders-bff");
    expect((await workspace.list()).map((r) => r.id)).toEqual(["orders-bff"]);
  });

  test("to samo repo dodane drugi raz nie tworzy nowego wpisu, inne o tej samej nazwie dostaje przyrostek", async () => {
    const { workspace } = newWorkspace();
    const first = makeRepo({ a: "1" }, "api");
    await workspace.add(first);
    await workspace.add(first);
    await workspace.add(makeRepo({ a: "1" }, "api"));

    expect((await workspace.list()).map((r) => r.id)).toEqual(["api", "api-2"]);
  });

  test("katalog spoza gita i ścieżka względna są odrzucane jako bad_request", async () => {
    const { workspace } = newWorkspace();
    await expect(workspace.add(mkdtempSync(join(tmpdir(), "pitwall-nie-git-")))).rejects.toMatchObject({ code: "bad_request" });
    await expect(workspace.add("wzgledna/sciezka")).rejects.toMatchObject({ code: "bad_request" });
  });

  test("repo, którego katalog zniknął, zostaje na liście jako niedostępne", async () => {
    const { workspace } = newWorkspace();
    const dir = makeRepo({ a: "1" });
    await workspace.add(dir);
    renameSync(dir, `${dir}-przeniesione`);

    const [repo] = await workspace.list();
    expect(repo?.status.kind).toBe("unavailable");
    await expect(workspace.tree(repo?.id ?? "", "")).rejects.toMatchObject({ code: "repo_unavailable" });
  });

  test("przegląd zawiera README i commity, drzewo i plik czytają z ostatniego commita", async () => {
    const { workspace } = newWorkspace();
    const { id } = await workspace.add(makeRepo({ "README.md": "# Opis\n", "readme.txt": "gorszy", "src/a.ts": "kod" }));

    const overview = await workspace.overview(id);
    expect(overview.readme).toEqual({ path: "README.md", text: "# Opis\n", truncated: false });
    expect(overview.commits.map((c) => c.subject)).toEqual(["pierwszy commit"]);
    expect((await workspace.tree(id, "")).map((e) => e.path)).toEqual(["src", "README.md", "readme.txt"]);
    expect(await workspace.file(id, "src/a.ts")).toMatchObject({ kind: "text", text: "kod" });
    await expect(workspace.file(id, "src")).rejects.toMatchObject({ code: "not_found" });
  });

  test("przegląd repo bez commitów nie ma README ani commitów", async () => {
    const { workspace } = newWorkspace();
    const { id } = await workspace.add(makeRepo());
    expect(await workspace.overview(id)).toMatchObject({ readme: null, commits: [] });
  });

  test("usunięcie zdejmuje repo tylko z listy, nieznane repo to not_found", async () => {
    const { workspace } = newWorkspace();
    const dir = makeRepo({ a: "1" });
    const { id } = await workspace.add(dir);

    workspace.remove(id);

    expect(await workspace.list()).toEqual([]);
    expect(readFileSync(join(dir, "a"), "utf8")).toBe("1");
    expect(() => workspace.remove(id)).toThrow(DomainError);
  });

  test("otwarcie w VS Code przekazuje adres vscode:// z katalogiem repo", async () => {
    const { workspace, opened } = newWorkspace();
    const { id, path } = await workspace.add(makeRepo({ a: "1" }));
    workspace.openEditor(id);
    expect(opened).toEqual([vscodeUrl(path)]);
  });
});

describe("vscodeUrl", () => {
  test("ścieżka z Windowsa i z macOS, znaki specjalne zakodowane", () => {
    expect(vscodeUrl("C:\\Users\\jan\\repo #1")).toBe("vscode://file/C:/Users/jan/repo%20%231");
    expect(vscodeUrl("/Users/jan/repo")).toBe("vscode://file/Users/jan/repo");
  });
});
