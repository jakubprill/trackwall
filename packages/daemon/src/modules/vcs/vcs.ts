import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type {
  Commit,
  FileContent,
  HostedProject,
  RepoHost,
  RepoStatusOk,
  SyncResult,
  TreeEntry,
  WorkingTreeChanges,
} from "@trackwall/protocol";
import { branchOnRemote, pushBranch } from "./branch-push.ts";
import { CommitMemo } from "./commit-memo.ts";
import {
  type BranchTip,
  type CommitRange,
  commitsBetween,
  countBetween,
  isAncestor,
  newestCommits,
  remoteDefaultBranch,
} from "./commit-range.ts";
import { ConfigMemo } from "./config-memo.ts";
import { git } from "./git.ts";
import { mainRemote, readConfig } from "./git-config.ts";
import { type GitState, GitStateReader } from "./git-state.ts";
import { grep, grepFiles } from "./grep.ts";
import { readHeadCommit } from "./head-commit.ts";
import { hostedProject } from "./hosted-project.ts";
import { KeyedQueue } from "./keyed-queue.ts";
import {
  type CommitFile,
  type GitObject,
  isBinary,
  LOG_FORMAT,
  parseBlobs,
  parseCommitFiles,
  parseLog,
  parseObjects,
  parseStatus,
  parseTree,
} from "./parse.ts";
import { pathKey } from "./path-key.ts";
import { remoteAddress } from "./remote.ts";
import { syncRepo } from "./sync.ts";
import { addWorktree, defaultBase, deleteBranch, pendingWork, removeWorktree } from "./worktree.ts";
import { workingTreeChanges, worktreeChanges } from "./worktree-changes.ts";
import { copyIncludedFiles } from "./worktree-include.ts";

/**
 * The `vcs` module (§4, §4.5): the local git adapter. It knows directories, not repo identifiers; `workspace` translates those.
 * It reads repo contents from the objects of the HEAD commit (ADR-14), so a path cannot point to a file outside the repo,
 * and browsing does not depend on what lies in the working directory; only the repo state and its changes read the
 * working directory (`changes`, ADR-34). Only two things change anything: `sync` (ADR-21), i.e. fetch, a fast-forward
 * of the default branch and an update of the working directory when that branch is checked out, agent task worktrees
 * (ADR-31): a new branch with a worktree, its removal and the removal of the branch, and the push of a task branch at the
 * user's request (ADR-77).
 */
export class Vcs {
  /**
   * Running syncs by `.git` directory (shared by a repo and its worktrees): a repo and its worktree, or a
   * link in the projects folder, are several list entries, and two simultaneous fetches in one `.git` fight over the
   * same refs and one fails.
   */
  private readonly syncing = new KeyedQueue();
  private readonly worktreeOps = new KeyedQueue();
  private readonly states = new GitStateReader();
  private readonly headCommits = new CommitMemo();
  private readonly configs = new ConfigMemo();

  /**
   * HEAD and refs of every repo read from the files of its git directory, without a `git` process (ADR-63); `null` for a
   * repo without a git directory, `undefined` for one that could not be read this time. What a read remembers is kept only
   * for the repos of the last call.
   */
  gitStates(dirs: readonly string[]): Promise<Map<string, GitState | null | undefined>> {
    return this.states.readAll(dirs);
  }

  /**
   * One `git status` per call: the HEAD commit's author, date and subject come from `headCommits` by the hash status gives,
   * so the repo list starts one process per repo (ADR-79), not two.
   */
  async status(dir: string): Promise<RepoStatusOk> {
    const { stdout } = await git(dir, ["status", "--porcelain=v2", "--branch", "-z"]);
    const { headOid, ...status } = parseStatus(stdout.toString("utf8"));
    return { ...status, head: headOid === null ? null : await this.headCommits.get(headOid, () => this.newestCommit(dir, headOid)) };
  }

  private async newestCommit(dir: string, commit: string): Promise<Commit | null> {
    const [head] = await newestCommits(dir, commit, 1);
    return head ?? null;
  }

  /**
   * The working directory against HEAD (ADR-34), with the same read as task changes, so without writing to the user's
   * index. In a repo without commits, against the empty tree: then every file is new.
   */
  async changes(dir: string, maxPatchBytes: number): Promise<WorkingTreeChanges> {
    return workingTreeChanges(dir, (await this.headCommit(dir)) ?? (await emptyTree(dir)), maxPatchBytes, []);
  }

  /** The address of the main remote (`origin` or the only one) as `host/path` (ADR-21); `null` without such a remote. */
  async remote(dir: string): Promise<string | null> {
    const remote = mainRemote(await this.configs.get(dir, () => readConfig(dir)));
    return (remote && remoteAddress(remote.url)) ?? null;
  }

  /**
   * The main remote as a project on GitHub or on one of `hosts` from the settings (ADR-77); `null` without a main remote
   * or on another host.
   */
  async hostedProject(dir: string, hosts: readonly RepoHost[]): Promise<HostedProject | null> {
    const address = await this.remote(dir);
    return address === null ? null : hostedProject(address, hosts);
  }

  /**
   * Fetch and fast-forward of the default branch (ADR-21); a skip reason is a result, and a git error an exception. Repos
   * with the same `.git` directory sync one after another.
   */
  async sync(dir: string): Promise<SyncResult> {
    return this.syncing.run(await this.commonDir(dir), () => syncRepo(dir));
  }

  /** A task branch against the main remote's branch of the same name, from refs only (ADR-77); `null` without a main remote. */
  readonly branchOnRemote = branchOnRemote;

  /**
   * Pushes a task branch to the main remote (ADR-77), in the same queue as sync: a fetch and a push in one `.git` both
   * write the remote-tracking refs.
   */
  async pushBranch(dir: string, branch: string): Promise<void> {
    return this.syncing.run(await this.commonDir(dir), () => pushBranch(dir, branch));
  }

  // `git grep` over a commit's objects (`grep.ts`): source files for cards (ADR-30) and code search (ADR-40).
  readonly grepFiles = grepFiles;
  readonly grep = grep;

  // Task worktrees (ADR-31, `worktree.ts`, `worktree-changes.ts`). Reads go straight through; changes to the worktree
  // registry and branches go one after another within one repo.
  readonly defaultBase = defaultBase;
  readonly pendingWork = pendingWork;
  readonly worktreeChanges = worktreeChanges;
  readonly copyIncludedFiles = copyIncludedFiles;

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
   * Worktree changes in one repo one after another: two simultaneous `worktree add` fight over locks in `.git`. Separate from
   * sync, because a fetch takes minutes and does not change the worktree registry or task branches.
   */
  private async serialWorktreeOp(repoDir: string, job: () => Promise<void>): Promise<void> {
    // A repo that no longer exists has no locks to guard (nor a `.git` to take the key from).
    if (!existsSync(repoDir)) return job();
    return this.worktreeOps.run(await this.commonDir(repoDir), job);
  }

  /** The `.git` directory shared by a repo and its worktrees as the queue key (`pathKey`). */
  private async commonDir(dir: string): Promise<string> {
    const { stdout } = await git(dir, ["rev-parse", "--git-common-dir"]);
    // The path is sometimes relative to the repo directory (`.git`), hence `resolve`.
    return pathKey(resolve(dir, stdout.toString("utf8").trim()));
  }

  /** The latest commits from HEAD; empty in a repo without commits (`--ignore-missing` skips a missing HEAD). */
  async log(dir: string, limit: number): Promise<Commit[]> {
    const { stdout } = await git(dir, ["log", "-z", "--ignore-missing", `--max-count=${limit}`, LOG_FORMAT, "HEAD", "--"]);
    return parseLog(stdout.toString("utf8"));
  }

  /** The main remote's default branch as the last fetch left it (`origin/main`) and its commit; `null` when unknown (ADR-70). */
  remoteDefaultBranch(dir: string): Promise<BranchTip | null> {
    return remoteDefaultBranch(dir);
  }

  /** Whether `ancestor` is in the history of `commit` (`false` for a commit the repo does not have). */
  isAncestor(dir: string, ancestor: string, commit: string): Promise<boolean> {
    return isAncestor(dir, ancestor, commit);
  }

  /** How many commits `to` has that `from` does not; `undefined` when `from` is unknown. */
  countBetween(dir: string, from: string, to: string): Promise<number | undefined> {
    return countBetween(dir, from, to);
  }

  /** The commits on `to` that `from` does not have: their number and the newest `limit`; `undefined` when `from` is unknown. */
  commitsBetween(dir: string, from: string, to: string, limit: number): Promise<CommitRange | undefined> {
    return commitsBetween(dir, from, to, limit);
  }

  /** The newest `limit` commits of `commit`'s history, newest first. */
  newestCommits(dir: string, commit: string, limit: number): Promise<Commit[]> {
    return newestCommits(dir, commit, limit);
  }

  /** The contents of directory `path` in HEAD; `undefined` when there is no such directory. An empty root in a repo without commits. */
  async tree(dir: string, path: string): Promise<TreeEntry[] | undefined> {
    const [head, object] = await this.objects(dir, ["HEAD", `HEAD:${path}`]);
    if (!head) return path === "" ? [] : undefined;
    if (object?.type !== "tree") return undefined;
    const { stdout } = await git(dir, ["ls-tree", "-z", "--long", object.oid]);
    return parseTree(stdout.toString("utf8"), path);
  }

  /** File `path` from HEAD, cut to `maxBytes`; `undefined` when there is no such file. */
  async file(dir: string, path: string, maxBytes: number): Promise<FileContent | undefined> {
    const [object] = await this.objects(dir, [`HEAD:${path}`]);
    if (object?.type !== "blob") return undefined;
    const { stdout, truncated } = await git(dir, ["cat-file", "blob", object.oid], { maxBytes });
    if (isBinary(stdout)) return { kind: "binary", size: object.size };
    return { kind: "text", text: stdout.toString("utf8"), size: object.size, truncated };
  }

  /** The full hash of the HEAD commit; `null` in a repo without commits. From the git directory's files when they tell for sure. */
  async headCommit(dir: string): Promise<string | null> {
    const fromFiles = await readHeadCommit(dir).catch(() => undefined);
    if (fromFiles !== undefined) return fromFiles;
    const [head] = await this.objects(dir, ["HEAD"]);
    return head?.type === "commit" ? head.oid : null;
  }

  /**
   * All files of a commit with their sizes and blob ids, without directories and submodules; `truncated` when the list exceeded
   * `maxBytes` of output (a repo with hundreds of thousands of files) and is incomplete.
   */
  async commitFiles(dir: string, commit: string, maxBytes: number): Promise<{ files: CommitFile[]; truncated: boolean }> {
    const { stdout, truncated } = await git(dir, ["ls-tree", "-r", "-z", "--long", commit], { maxBytes });
    const files = parseCommitFiles(stdout.toString("utf8"));
    // The last record of cut output may be an incomplete path.
    return { files: truncated ? files.slice(0, -1) : files, truncated };
  }

  /**
   * The contents of many commit files in one process (`cat-file --batch`), without filters and `textconv`, so the repo does not
   * run any program meanwhile. A file that is missing or did not fit in `maxBytes` of the whole
   * output does not get into the result.
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
   * Existence, type and size of objects in one process (`cat-file --batch-check`); `undefined` for a missing one,
   * also for a submodule whose commit is not in this repo. Specifications go by lines, hence the ban on control
   * characters in `RepoPath`.
   */
  private async objects(dir: string, specs: string[]): Promise<(GitObject | undefined)[]> {
    const { stdout } = await git(dir, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
      stdin: `${specs.join("\n")}\n`,
    });
    return parseObjects(stdout.toString("utf8"), specs.length);
  }
}

/** The hash of the empty tree in the repo's object format (SHA-1 or SHA-256), without writing to `.git/objects`. */
async function emptyTree(dir: string): Promise<string> {
  return (await git(dir, ["hash-object", "-t", "tree", "--stdin"], { stdin: "" })).stdout.toString("utf8").trim();
}
