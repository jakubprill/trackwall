import { resolve } from "node:path";
import type { Commit, FileContent, TreeEntry } from "@pitwall/protocol";
import { GitError, git } from "./git.ts";
import { type GitStatus, isBinary, LOG_FORMAT, parseLog, parseStatus, parseTree } from "./parse.ts";

/**
 * Moduł `vcs` (§4): lokalny adapter gita. Zna katalogi, nie identyfikatory repo; te tłumaczy `workspace`.
 * Zawartość repo czyta z commita HEAD (`git show` bez checkoutu), więc ścieżka nie może wskazać pliku spoza repo,
 * a przeglądanie nie zależy od tego, co leży w katalogu roboczym.
 */
export class Vcs {
  /** Korzeń repo, w którym leży `dir`; `GitError`, gdy `dir` nie jest w repo gita. */
  async toplevel(dir: string): Promise<string> {
    const { stdout } = await git(dir, ["rev-parse", "--show-toplevel"]);
    // Git na Windowsie zwraca `C:/...`; `resolve` sprowadza to do postaci z `node:path`.
    return resolve(stdout.toString("utf8").trim());
  }

  async status(dir: string): Promise<GitStatus> {
    const { stdout } = await git(dir, ["status", "--porcelain=v2", "--branch", "-z"]);
    const { hasCommits, ...status } = parseStatus(stdout.toString("utf8"));
    const [head] = hasCommits ? await this.log(dir, 1) : [];
    return { ...status, head: head ?? null };
  }

  async log(dir: string, limit: number): Promise<Commit[]> {
    const { stdout } = await git(dir, ["log", "-z", `--max-count=${limit}`, LOG_FORMAT, "HEAD", "--"]);
    return parseLog(stdout.toString("utf8"));
  }

  /** Zawartość katalogu `path` w HEAD; `undefined`, gdy nie ma takiego katalogu. Pusty korzeń w repo bez commitów. */
  async tree(dir: string, path: string): Promise<TreeEntry[] | undefined> {
    const object = await this.objectAtHead(dir, path);
    if (object === undefined) return path === "" && !(await this.hasCommits(dir)) ? [] : undefined;
    if (object.type !== "tree") return undefined;
    const { stdout } = await git(dir, ["ls-tree", "-z", "--long", object.oid]);
    return parseTree(stdout.toString("utf8"), path);
  }

  /** Plik `path` z HEAD, ucięty do `maxBytes`; `undefined`, gdy nie ma takiego pliku. */
  async file(dir: string, path: string, maxBytes: number): Promise<FileContent | undefined> {
    const object = await this.objectAtHead(dir, path);
    if (object?.type !== "blob") return undefined;
    const { stdout, truncated } = await git(dir, ["cat-file", "blob", object.oid], { maxBytes });
    const size = truncated ? Number((await git(dir, ["cat-file", "-s", object.oid])).stdout.toString("utf8").trim()) : stdout.length;
    if (isBinary(stdout)) return { kind: "binary", size };
    return { kind: "text", text: stdout.toString("utf8"), size, truncated };
  }

  private async hasCommits(dir: string): Promise<boolean> {
    return (await this.revParse(dir, "HEAD")) !== undefined;
  }

  private async objectAtHead(dir: string, path: string): Promise<{ oid: string; type: string } | undefined> {
    // `HEAD:` (pusta ścieżka) to drzewo korzenia.
    const oid = await this.revParse(dir, `HEAD:${path}`);
    if (oid === undefined) return undefined;
    const { stdout } = await git(dir, ["cat-file", "-t", oid]);
    return { oid, type: stdout.toString("utf8").trim() };
  }

  /** `undefined`, gdy obiekt nie istnieje (kod 1 z `--verify --quiet`); każdy inny błąd gita leci dalej. */
  private async revParse(dir: string, spec: string): Promise<string | undefined> {
    try {
      const { stdout } = await git(dir, ["rev-parse", "--verify", "--quiet", spec]);
      return stdout.toString("utf8").trim();
    } catch (err) {
      if (err instanceof GitError && err.exitCode === 1) return undefined;
      throw err;
    }
  }
}
