import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { Commit, FileContent, RepoStatusOk, SyncResult, TreeEntry } from "@trackwall/protocol";
import { git } from "./git.ts";
import { mainRemote, readConfig } from "./git-config.ts";
import { type GitObject, isBinary, LOG_FORMAT, parseLog, parseObjects, parseStatus, parseTree } from "./parse.ts";
import { remoteAddress } from "./remote.ts";
import { syncRepo } from "./sync.ts";

/**
 * Moduł `vcs` (§4, §4.5): lokalny adapter gita. Zna katalogi, nie identyfikatory repo; te tłumaczy `workspace`.
 * Zawartość repo czyta z obiektów commita HEAD (ADR-14), więc ścieżka nie może wskazać pliku spoza repo,
 * a przeglądanie nie zależy od tego, co leży w katalogu roboczym. Jedyna komenda, która coś zmienia, to `sync`
 * (ADR-21): fetch, fast-forward gałęzi domyślnej i aktualizacja katalogu roboczego, gdy ta gałąź jest wybrana.
 */
export class Vcs {
  /**
   * Trwające synchronizacje po katalogu `.git` (wspólnym dla repo i jego worktree): repo i jego worktree albo
   * dowiązanie w folderze z projektami to kilka wpisów listy, a dwa równoczesne fetch w jednym `.git` walczą o te
   * same refy i jeden pada.
   */
  private readonly syncing = new Map<string, Promise<void>>();

  async status(dir: string): Promise<RepoStatusOk> {
    const { stdout } = await git(dir, ["status", "--porcelain=v2", "--branch", "-z"]);
    const { hasCommits, ...status } = parseStatus(stdout.toString("utf8"));
    const [head] = hasCommits ? await this.log(dir, 1) : [];
    return { ...status, head: head ?? null };
  }

  /** Adres głównego remote (`origin` albo jedyny) jako `host/ścieżka` (ADR-21); `null` bez takiego remote. */
  async remote(dir: string): Promise<string | null> {
    const remote = mainRemote(await readConfig(dir));
    return (remote && remoteAddress(remote.url)) ?? null;
  }

  /**
   * Fetch i fast-forward gałęzi domyślnej (ADR-21); powód pominięcia jest wynikiem, a błąd gita wyjątkiem. Repo
   * z tym samym katalogiem `.git` synchronizują się po kolei.
   */
  async sync(dir: string): Promise<SyncResult> {
    const key = await this.commonDir(dir);
    const result = (this.syncing.get(key) ?? Promise.resolve()).then(() => syncRepo(dir));
    // Następny czeka na koniec, nie na sukces; błąd dostaje tylko wołający.
    const done = result.then(
      () => {},
      () => {},
    );
    this.syncing.set(key, done);
    void done.then(() => {
      if (this.syncing.get(key) === done) this.syncing.delete(key);
    });
    return result;
  }

  /** Katalog `.git` wspólny dla repo i jego worktree, po rozwinięciu dowiązań; klucz bez wielkości liter jak dyski Windowsa i macOS. */
  private async commonDir(dir: string): Promise<string> {
    const { stdout } = await git(dir, ["rev-parse", "--git-common-dir"]);
    // Ścieżka bywa względna do katalogu repo (`.git`), stąd `resolve`.
    const path = resolve(dir, stdout.toString("utf8").trim());
    return (await realpath(path).catch(() => path)).toLowerCase();
  }

  /** Ostatnie commity od HEAD; pusto w repo bez commitów (`--ignore-missing` pomija nieistniejący HEAD). */
  async log(dir: string, limit: number): Promise<Commit[]> {
    const { stdout } = await git(dir, ["log", "-z", "--ignore-missing", `--max-count=${limit}`, LOG_FORMAT, "HEAD", "--"]);
    return parseLog(stdout.toString("utf8"));
  }

  /** Zawartość katalogu `path` w HEAD; `undefined`, gdy nie ma takiego katalogu. Pusty korzeń w repo bez commitów. */
  async tree(dir: string, path: string): Promise<TreeEntry[] | undefined> {
    const [head, object] = await this.objects(dir, ["HEAD", `HEAD:${path}`]);
    if (!head) return path === "" ? [] : undefined;
    if (object?.type !== "tree") return undefined;
    const { stdout } = await git(dir, ["ls-tree", "-z", "--long", object.oid]);
    return parseTree(stdout.toString("utf8"), path);
  }

  /** Plik `path` z HEAD, ucięty do `maxBytes`; `undefined`, gdy nie ma takiego pliku. */
  async file(dir: string, path: string, maxBytes: number): Promise<FileContent | undefined> {
    const [object] = await this.objects(dir, [`HEAD:${path}`]);
    if (object?.type !== "blob") return undefined;
    const { stdout, truncated } = await git(dir, ["cat-file", "blob", object.oid], { maxBytes });
    if (isBinary(stdout)) return { kind: "binary", size: object.size };
    return { kind: "text", text: stdout.toString("utf8"), size: object.size, truncated };
  }

  /**
   * Istnienie, typ i rozmiar obiektów w jednym procesie (`cat-file --batch-check`); `undefined` dla brakującego,
   * także dla submodułu, którego commitu nie ma w tym repo. Specyfikacje idą liniami, stąd zakaz znaków
   * sterujących w `RepoPath`.
   */
  private async objects(dir: string, specs: string[]): Promise<(GitObject | undefined)[]> {
    const { stdout } = await git(dir, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
      stdin: `${specs.join("\n")}\n`,
    });
    return parseObjects(stdout.toString("utf8"), specs.length);
  }
}
