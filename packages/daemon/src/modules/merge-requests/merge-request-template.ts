import { MERGE_REQUEST_DESCRIPTION_MAX, type MergeRequestTemplate, type RepoHostKind } from "@trackwall/protocol";

/**
 * The repo's own merge request template (ADR-238, §4.12): the file the repo host would put into a new merge request's
 * description by itself, which it leaves out once the form's address carries a description. Read from the task's base
 * commit, as the rules of a rules check are (ADR-234), so a template the agent edited or added does not shape the
 * description of its own change.
 */

/**
 * Where each repo host takes its default template from, in the order it looks, in the spellings repos use: GitLab's
 * `Default.md` among the merge request templates, GitHub's `pull_request_template.md` in `.github/`, the root or `docs/`.
 * A folder of several templates (GitHub's `PULL_REQUEST_TEMPLATE/`, GitLab's other names) has no default to pick.
 */
const TEMPLATE_PATHS: Record<RepoHostKind, readonly string[]> = {
  gitlab: [".gitlab/merge_request_templates/Default.md", ".gitlab/merge_request_templates/default.md"],
  github: [".github", "", "docs"].flatMap((dir) =>
    ["pull_request_template.md", "PULL_REQUEST_TEMPLATE.md"].map((name) => (dir === "" ? name : `${dir}/${name}`)),
  ),
};

/** Bytes of a template read at most: more than a description holds, so a longer one still shows that it was cut. */
const TEMPLATE_MAX_BYTES = MERGE_REQUEST_DESCRIPTION_MAX * 4;

/** What the template needs from `vcs`. */
export interface TemplateVcs {
  readFiles(dir: string, commit: string, paths: readonly string[], maxBytes: number): Promise<Map<string, Buffer>>;
}

/** The repo's template for `kind` at commit `base` of `worktree`, its text cut to what a description holds; `null` without one. */
export async function readMergeRequestTemplate(
  vcs: TemplateVcs,
  worktree: string,
  base: string,
  kind: RepoHostKind,
): Promise<MergeRequestTemplate | null> {
  const paths = TEMPLATE_PATHS[kind];
  const found = await vcs.readFiles(worktree, base, paths, TEMPLATE_MAX_BYTES * paths.length);
  for (const path of paths) {
    const blob = found.get(path);
    if (blob === undefined) continue;
    // Windows line ends would show as stray characters in the form; the cut is by code points, never inside an emoji.
    const text = Array.from(blob.toString("utf8").replace(/\r\n/g, "\n")).slice(0, MERGE_REQUEST_DESCRIPTION_MAX).join("");
    return text.trim() === "" ? null : { path, text };
  }
  return null;
}
