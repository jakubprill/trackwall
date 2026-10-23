import { resolve } from "node:path";
import type { Commit, FileContent, RepoStatusOk, TreeEntry } from "@pitwall/protocol";
import { git } from "./git.ts";
import { type GitObject, isBinary, LOG_FORMAT, parseLog, parseObjects, parseStatus, parseTree } from "./parse.ts";

/**
 * Moduł `vcs` (§4, §4.5): lokalny adapter gita. Zna katalogi, nie identyfikatory repo; te tłumaczy `workspace`.
 * Zawartość repo czyta z obiektów commita HEAD (ADR-13), więc ścieżka nie może wskazać pliku spoza repo,
 * a przeglądanie nie zależy od tego, co leży w katalogu roboczym.
 */
export class Vcs {
  /** Korzeń repo, w którym leży `dir`; błąd z komunikatem gita, gdy `dir` nie jest w repo gita. */
  async toplevel(dir: string): Promise<string> {
    const { stdout } = await git(dir, ["rev-parse", "--show-toplevel"]);
    // Tylko końcowy znak nowej linii: spacja na końcu nazwy katalogu jest częścią ścieżki.
    // Git na Windowsie zwraca `C:/...`; `resolve` sprowadza to do postaci z `node:path`.
    return resolve(stdout.toString("utf8").replace(/\r?\n$/, ""));
  }

  async status(dir: string): Promise<RepoStatusOk> {
    const { stdout } = await git(dir, ["status", "--porcelain=v2", "--branch", "-z"]);
    const { hasCommits, ...status } = parseStatus(stdout.toString("utf8"));
    const [head] = hasCommits ? await this.log(dir, 1) : [];
    return { ...status, head: head ?? null };
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
