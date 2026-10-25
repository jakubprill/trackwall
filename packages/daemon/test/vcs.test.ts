import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vcs } from "../src/modules/vcs/vcs.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";

const vcs = new Vcs();

describe("vcs na prawdziwym gicie", () => {
  test("nieudane utworzenie worktree nie zostawia gałęzi, więc ponowna próba z tą samą gałęzią się udaje", async () => {
    const dir = makeRepo({ "README.md": "# repo\n" });
    const commit = gitIn(dir, "rev-parse", "HEAD").trim();
    const path = join(mkdtempSync(join(tmpdir(), "trackwall-worktrees-")), "zadanie");
    mkdirSync(path);
    writeFileSync(join(path, "zajete.txt"), "katalog nie jest pusty");

    await expect(vcs.addWorktree(dir, path, "trackwall/zadanie-abc123", commit)).rejects.toThrow();
    expect(gitIn(dir, "branch", "--list", "trackwall/*").trim()).toBe("");
    expect(existsSync(path)).toBe(false);

    await vcs.addWorktree(dir, path, "trackwall/zadanie-abc123", commit);
    expect(gitIn(path, "branch", "--show-current").trim()).toBe("trackwall/zadanie-abc123");
  });

  test("utworzenie worktree na gałęzi, która już jest, odmawia i jej nie usuwa", async () => {
    const dir = makeRepo({ "README.md": "# repo\n" });
    const commit = gitIn(dir, "rev-parse", "HEAD").trim();
    gitIn(dir, "branch", "trackwall/moja");
    const path = join(mkdtempSync(join(tmpdir(), "trackwall-worktrees-")), "zadanie");

    await expect(vcs.addWorktree(dir, path, "trackwall/moja", commit)).rejects.toThrow("a branch named 'trackwall/moja' already exists");
    expect(gitIn(dir, "branch", "--list", "trackwall/moja").trim()).toBe("trackwall/moja");
  });

  test("status pokazuje gałąź, ostatni commit i niezacommitowane zmiany", async () => {
    const dir = makeRepo({ "README.md": "# repo\n" });
    commitFiles(dir, { "src/app.ts": "export {};\n" }, "Dodaj aplikację");
    writeFileSync(join(dir, "README.md"), "# repo zmienione\n");
    writeFileSync(join(dir, "nowy.txt"), "x");

    const status = await vcs.status(dir);

    expect(status).toMatchObject({ kind: "ok", branch: "main", changes: 2, untracked: 1, upstream: null });
    expect(status.head).toMatchObject({ subject: "Dodaj aplikację", author: "Testowy Autor" });
    expect(status.head?.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  test.each(["sha1", "sha256"] as const)(
    "liczenie zmian z nowymi plikami, także pustym i osadzonym repo, nie zapisuje do repo żadnego obiektu (%s)",
    async (objectFormat) => {
      // Zapis obiektu przy każdym liczeniu sprawiał, że kilka okien „Changes” naraz pisało ten sam pusty blob, a na Windowsie
      // drugi zapis kończył się „Permission denied” (#36).
      const dir = makeRepo({ "README.md": "# repo\n" }, "repo", undefined, objectFormat);
      const base = gitIn(dir, "rev-parse", "HEAD").trim();
      writeFileSync(join(dir, "nowy.md"), "x\n");
      writeFileSync(join(dir, "pusty.md"), "");
      const embeddedHead = gitIn(makeRepo({ "a.txt": "a\n" }, "osadzone", dir, objectFormat), "rev-parse", "HEAD").trim();
      makeRepo({}, "osadzone-bez-commitow", dir, objectFormat);
      // Repo z obiektami w innym formacie nie może być submodułem; `update-index` odrzuciłby przez nie wszystkie wpisy.
      makeRepo({ "b.txt": "b\n" }, "osadzone-w-innym-formacie", dir, objectFormat === "sha1" ? "sha256" : "sha1");
      const objectsBefore = gitIn(dir, "count-objects", "-v");

      const changes = await vcs.worktreeChanges(dir, base, 1_000_000);

      expect(changes.files.map((f) => f.path)).toEqual(["nowy.md", "osadzone", "pusty.md"]);
      expect(changes.patch).toContain("+x");
      expect(changes.patch).toContain(`+Subproject commit ${embeddedHead}`);
      expect(gitIn(dir, "count-objects", "-v")).toBe(objectsBefore);
    },
  );

  test.skipIf(process.platform !== "linux")(
    "nowy plik z nazwą spoza UTF-8 jest w zmianach (Linux; Windows i macOS takich nazw nie mają)",
    async () => {
      const dir = makeRepo({ "README.md": "# repo\n" });
      const base = gitIn(dir, "rev-parse", "HEAD").trim();
      writeFileSync(Buffer.concat([Buffer.from(join(dir, "zly-")), Buffer.from([0xff])]), "x\n");

      const changes = await vcs.worktreeChanges(dir, base, 1_000_000);

      expect(changes.files).toHaveLength(1);
      expect(changes.patch).toContain("+x");
    },
  );

  test("status repo bez commitów ma pusty HEAD, log jest pusty, a korzeń drzewa jest pusty", async () => {
    const dir = makeRepo();
    expect(await vcs.status(dir)).toMatchObject({ kind: "ok", branch: "main", head: null, changes: 0 });
    expect(await vcs.log(dir, 10)).toEqual([]);
    expect(await vcs.tree(dir, "")).toEqual([]);
    expect(await vcs.tree(dir, "src")).toBeUndefined();
  });

  test("changes pokazuje zmienione, usunięte i nowe pliki względem HEAD z diffem, bez ignorowanych i bez zmiany indeksu", async () => {
    const dir = makeRepo({ "README.md": "# repo\n", "stary.txt": "x\n", ".gitignore": "build/\n" });
    writeFileSync(join(dir, "README.md"), "# repo zmienione\n");
    rmSync(join(dir, "stary.txt"));
    writeFileSync(join(dir, "nowy.txt"), "nowa linia\n");
    mkdirSync(join(dir, "build"));
    writeFileSync(join(dir, "build", "wynik.txt"), "ignorowany\n");
    const index = readFileSync(join(dir, ".git", "index"));

    const changes = await vcs.changes(dir, 1024 * 1024);

    expect(changes.files).toEqual([
      { path: "README.md", change: "modified", additions: 1, deletions: 1 },
      { path: "nowy.txt", change: "added", additions: 1, deletions: 0 },
      { path: "stary.txt", change: "deleted", additions: 0, deletions: 1 },
    ]);
    expect(changes.patch).toContain("+# repo zmienione");
    expect(changes.patch).toContain("+nowa linia");
    expect(changes.truncated).toBe(false);
    expect(readFileSync(join(dir, ".git", "index"))).toEqual(index);
    expect(gitIn(dir, "status", "--porcelain")).toContain("?? nowy.txt");
  });

  test("changes w repo bez commitów pokazuje każdy plik jako nowy", async () => {
    const dir = makeRepo();
    writeFileSync(join(dir, "pierwszy.txt"), "a\n");

    expect((await vcs.changes(dir, 1024 * 1024)).files).toEqual([{ path: "pierwszy.txt", change: "added", additions: 1, deletions: 0 }]);
  });

  test("ahead/behind względem gałęzi śledzonej", async () => {
    const remote = makeRepo({ "a.txt": "1" }, "zdalne");
    const parent = join(remote, "..");
    gitIn(parent, "clone", "-q", remote, "klon");
    const clone = join(parent, "klon");
    commitFiles(clone, { "b.txt": "2" }, "lokalny");
    commitFiles(remote, { "c.txt": "3" }, "zdalny");
    gitIn(clone, "fetch", "-q");

    expect((await vcs.status(clone)).upstream).toEqual({ name: "origin/main", ahead: 1, behind: 1 });
  });

  test("tree listuje katalog z ostatniego commita, bez plików niezacommitowanych", async () => {
    const dir = makeRepo({ "src/a.ts": "aa", "src/lib/b.ts": "b", "README.md": "r" });
    writeFileSync(join(dir, "src", "roboczy.ts"), "nie w commicie");

    expect(await vcs.tree(dir, "src")).toEqual([
      { name: "lib", path: "src/lib", kind: "dir" },
      { name: "a.ts", path: "src/a.ts", kind: "file", size: 2 },
    ]);
    expect(await vcs.tree(dir, "README.md")).toBeUndefined();
    expect(await vcs.tree(dir, "nie-ma")).toBeUndefined();
  });

  test("file zwraca tekst, rozpoznaje plik binarny i ucina duży plik, podając pełny rozmiar", async () => {
    const dir = makeRepo({
      "a.txt": "zażółć\n",
      "obraz.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
      "duzy.txt": "x".repeat(5000),
    });

    expect(await vcs.file(dir, "a.txt", 1024)).toEqual({
      kind: "text",
      text: "zażółć\n",
      size: Buffer.byteLength("zażółć\n"),
      truncated: false,
    });
    expect(await vcs.file(dir, "obraz.png", 1024)).toEqual({ kind: "binary", size: 6 });
    expect(await vcs.file(dir, "duzy.txt", 100)).toEqual({ kind: "text", text: "x".repeat(100), size: 5000, truncated: true });
    expect(await vcs.file(dir, "nie-ma.txt", 100)).toBeUndefined();
  });

  test("log zwraca commity od najnowszego", async () => {
    const dir = makeRepo({ "a.txt": "1" });
    commitFiles(dir, { "a.txt": "2" }, "drugi");
    expect((await vcs.log(dir, 10)).map((c) => c.subject)).toEqual(["drugi", "pierwszy commit"]);
  });

  test("submoduł nie jest ani katalogiem, ani plikiem do odczytu", async () => {
    const inner = makeRepo({ "lib.ts": "1" }, "biblioteka");
    const dir = makeRepo({ "a.txt": "1" });
    gitIn(dir, "-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "vendor");
    gitIn(dir, "commit", "-q", "-m", "submoduł");

    expect(((await vcs.tree(dir, "")) ?? []).map((e) => [e.name, e.kind])).toContainEqual(["vendor", "submodule"]);
    expect(await vcs.tree(dir, "vendor")).toBeUndefined();
    expect(await vcs.file(dir, "vendor", 100)).toBeUndefined();
  });

  test("odziedziczone GIT_DIR nie podmienia repo wskazanego przez -C", async () => {
    const alfa = makeRepo({ "alfa.txt": "a" }, "alfa");
    const beta = makeRepo({ "beta.txt": "b" }, "beta");
    const before = process.env.GIT_DIR;
    process.env.GIT_DIR = join(beta, ".git");
    try {
      expect(((await vcs.tree(alfa, "")) ?? []).map((e) => e.name)).toEqual(["alfa.txt"]);
    } finally {
      if (before === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = before;
    }
  });

  test("grepFiles zwraca pliki z commita pasujące do wzorca w danych rozszerzeniach, a brak trafień to pusta lista, nie błąd", async () => {
    const dir = makeRepo({
      "src/main/java/a/Api.java": "@RestController class Api {}\n",
      "src/main/kotlin/a/Client.kt": '@FeignClient("x") interface Client\n',
      "docs/notes.md": "@RestController w dokumentacji\n",
      "src/main/java/a/Plain.java": "class Plain {}\n",
    });
    writeFileSync(join(dir, "src", "main", "java", "a", "Plain.java"), "@RestController class Plain {}\n");
    const head = (await vcs.status(dir)).head?.hash ?? "";

    const found = await vcs.grepFiles(dir, head, "@(RestController|FeignClient)", ["*.java", "*.kt"], 1024 * 1024);
    expect(found).toEqual({ paths: ["src/main/java/a/Api.java", "src/main/kotlin/a/Client.kt"], truncated: false });
    expect(await vcs.grepFiles(dir, head, "@HttpExchange", ["*.java"], 1024 * 1024)).toEqual({ paths: [], truncated: false });
  });

  test("brak katalogu repo to błąd gita z komunikatem, a nie wyjątek uruchomienia", async () => {
    await expect(vcs.status(join(makeRepo(), "..", "nie-istnieje"))).rejects.toThrow(/nie-istnieje/);
  });

  test("a file changed to the same size in the second the index was written is a change, as git sees it", async () => {
    const dir = makeRepo({ "a.txt": "a\n" }, "racy");
    const base = gitIn(dir, "rev-parse", "HEAD").trim();
    gitIn(dir, "config", "core.trustctime", "false");
    // The index entry gets the file's time from ten seconds ago, so git does not mark it as possibly changed.
    const second = new Date(Math.floor(Date.now() / 1000 - 10) * 1000);
    utimesSync(join(dir, "a.txt"), second, second);
    gitIn(dir, "update-index", "--refresh");
    // The same size and time as in the index entry, and the index file from the same second: git then compares the
    // content ("racy git" in git's documentation), and so must the changes of a task.
    writeFileSync(join(dir, "a.txt"), "b\n");
    utimesSync(join(dir, "a.txt"), second, second);
    utimesSync(join(dir, ".git", "index"), second, second);

    const changes = await vcs.worktreeChanges(dir, base, 0);

    expect(changes.files).toEqual([{ path: "a.txt", change: "modified", additions: 1, deletions: 1 }]);
  });

  test("zmiany worktree z limitem diffu 0 dają pliki i liczby bez treści zmian", async () => {
    const dir = makeRepo({ "a.txt": "a\n" }, "bez-diffu");
    const base = gitIn(dir, "rev-parse", "HEAD").trim();
    writeFileSync(join(dir, "a.txt"), "b\n");
    const changes = await vcs.worktreeChanges(dir, base, 0);
    expect(changes).toEqual({
      files: [{ path: "a.txt", change: "modified", additions: 1, deletions: 1 }],
      patch: "",
      truncated: false,
      commits: 0,
      uncommitted: 1,
    });
  });
});
