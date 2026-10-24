import { resolve } from "node:path";
import type { Commit, FileContent, RepoStatusOk, SyncResult, TreeEntry } from "@trackwall/protocol";
import { git } from "./git.ts";
import { mainRemote, readConfig } from "./git-config.ts";
import { KeyedQueue } from "./keyed-queue.ts";
import { type GitObject, isBinary, LOG_FORMAT, parseBlobs, parseLog, parseObjects, parseStatus, parseTree } from "./parse.ts";
import { pathKey } from "./path-key.ts";
import { remoteAddress } from "./remote.ts";
import { syncRepo } from "./sync.ts";
import { addWorktree, defaultBase, deleteBranch, pendingWork, removeWorktree } from "./worktree.ts";
import { worktreeChanges } from "./worktree-changes.ts";

/**
 * Moduł `vcs` (§4, §4.5): lokalny adapter gita. Zna katalogi, nie identyfikatory repo; te tłumaczy `workspace`.
 * Zawartość repo czyta z obiektów commita HEAD (ADR-14), więc ścieżka nie może wskazać pliku spoza repo,
 * a przeglądanie nie zależy od tego, co leży w katalogu roboczym. Zmieniają coś tylko `sync` (ADR-21): fetch,
 * fast-forward gałęzi domyślnej i aktualizacja katalogu roboczego, gdy ta gałąź jest wybrana, oraz worktree zadań
 * agentów (ADR-31): nowa gałąź z worktree, jej usunięcie i usunięcie gałęzi.
 */
export class Vcs {
  /**
   * Trwające synchronizacje po katalogu `.git` (wspólnym dla repo i jego worktree): repo i jego worktree albo
   * dowiązanie w folderze z projektami to kilka wpisów listy, a dwa równoczesne fetch w jednym `.git` walczą o te
   * same refy i jeden pada.
   */
  private readonly syncing = new KeyedQueue();
  private readonly worktreeOps = new KeyedQueue();

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
    return this.syncing.run(await this.commonDir(dir), () => syncRepo(dir));
  }

  // Worktree zadań (ADR-31, `worktree.ts`, `worktree-changes.ts`). Odczyty idą wprost; zmiany rejestru worktree
  // i gałęzi po kolei w jednym repo.
  readonly defaultBase = defaultBase;
  readonly pendingWork = pendingWork;
  readonly worktreeChanges = worktreeChanges;

  addWorktree(repoDir: string, path: string, branch: string, commit: string): Promise<void> {
    return this.serialWorktreeOp(repoDir, () => addWorktree(repoDir, path, branch, commit));
  }

  removeWorktree(repoDir: string, path: string): Promise<void> {
    return this.serialWorktreeOp(repoDir, () => removeWorktree(repoDir, path));
  }

  deleteBranch(repoDir: string, branch: string): Promise<void> {
    return this.serialWorktreeOp(repoDir, () => deleteBranch(repoDir, branch));
  }

  /**
   * Zmiany worktree w jednym repo po kolei: dwa równoczesne `worktree add` walczą o blokady w `.git`. Osobno od
   * synchronizacji, bo fetch trwa minutami, a nie zmienia rejestru worktree ani gałęzi zadań.
   */
  private async serialWorktreeOp(repoDir: string, job: () => Promise<void>): Promise<void> {
    return this.worktreeOps.run(await this.commonDir(repoDir), job);
  }

  /** Katalog `.git` wspólny dla repo i jego worktree jako klucz kolejki (`pathKey`). */
  private async commonDir(dir: string): Promise<string> {
    const { stdout } = await git(dir, ["rev-parse", "--git-common-dir"]);
    // Ścieżka bywa względna do katalogu repo (`.git`), stąd `resolve`.
    return pathKey(resolve(dir, stdout.toString("utf8").trim()));
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

  /** Pełny hash commita HEAD; `null` w repo bez commitów. */
  async headCommit(dir: string): Promise<string | null> {
    const [head] = await this.objects(dir, ["HEAD"]);
    return head?.type === "commit" ? head.oid : null;
  }

  /**
   * Wszystkie pliki commita z rozmiarami, bez katalogów i submodułów; `truncated`, gdy lista przekroczyła
   * `maxBytes` wyjścia (repo z setkami tysięcy plików) i jest niepełna.
   */
  async commitFiles(dir: string, commit: string, maxBytes: number): Promise<{ files: TreeEntry[]; truncated: boolean }> {
    const { stdout, truncated } = await git(dir, ["ls-tree", "-r", "-z", "--long", commit], { maxBytes });
    const files = parseTree(stdout.toString("utf8"), "").filter((e) => e.kind === "file");
    // Ostatni rekord uciętego wyjścia może być niepełną ścieżką.
    return { files: truncated ? files.slice(0, -1) : files, truncated };
  }

  /**
   * Treść wielu plików commita jednym procesem (`cat-file --batch`), bez filtrów i `textconv`, więc repo nie
   * uruchamia przy tym żadnego programu. Plik, którego nie ma albo który nie zmieścił się w `maxBytes` całego
   * wyjścia, nie trafia do wyniku.
   */
  async readFiles(dir: string, commit: string, paths: readonly string[], maxBytes: number): Promise<Map<string, Buffer>> {
    if (paths.length === 0) return new Map();
    const { stdout } = await git(dir, ["cat-file", "--batch"], { stdin: `${paths.map((p) => `${commit}:${p}`).join("\n")}\n`, maxBytes });
    const blobs = parseBlobs(stdout, paths.length);
    const read = new Map<string, Buffer>();
    blobs.forEach((blob, i) => {
      const path = paths[i];
      if (blob && path !== undefined) read.set(path, blob);
    });
    return read;
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
