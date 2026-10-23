import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Vcs } from "../src/modules/vcs/vcs.ts";
import { commitFiles, gitIn, makeRepo } from "./support/git-repo.ts";

const vcs = new Vcs();

describe("vcs na prawdziwym gicie", () => {
  test("status pokazuje gałąź, ostatni commit i niezacommitowane zmiany", async () => {
    const dir = makeRepo({ "README.md": "# repo\n" });
    commitFiles(dir, { "src/app.ts": "export {};\n" }, "Dodaj aplikację");
    writeFileSync(join(dir, "README.md"), "# repo zmienione\n");
    writeFileSync(join(dir, "nowy.txt"), "x");

    const status = await vcs.status(dir);

    expect(status).toMatchObject({ kind: "ok", branch: "main", changes: 2, upstream: null });
    expect(status.head).toMatchObject({ subject: "Dodaj aplikację", author: "Testowy Autor" });
    expect(status.head?.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  test("status repo bez commitów ma pusty HEAD, a korzeń drzewa jest pusty", async () => {
    const dir = makeRepo();
    expect(await vcs.status(dir)).toMatchObject({ kind: "ok", branch: "main", head: null, changes: 0 });
    expect(await vcs.tree(dir, "")).toEqual([]);
    expect(await vcs.tree(dir, "src")).toBeUndefined();
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

  test("toplevel z podkatalogu zwraca korzeń repo, a katalog spoza repo kończy się błędem", async () => {
    const dir = makeRepo({ "src/deep/x.ts": "1" });
    expect(await vcs.toplevel(join(dir, "src", "deep"))).toBe(await vcs.toplevel(dir));
    await expect(vcs.toplevel(join(dir, ".."))).rejects.toThrow();
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

  test("brak katalogu repo to błąd gita z komunikatem, a nie wyjątek uruchomienia", async () => {
    await expect(vcs.status(join(makeRepo(), "..", "nie-istnieje"))).rejects.toThrow(/nie-istnieje/);
  });
});
