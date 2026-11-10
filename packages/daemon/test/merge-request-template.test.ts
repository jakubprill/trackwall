import { describe, expect, test } from "bun:test";
import { MERGE_REQUEST_DESCRIPTION_MAX } from "@trackwall/protocol";
import { readMergeRequestTemplate } from "../src/modules/merge-requests/merge-request-template.ts";

/** A commit holding `files`, read the way `vcs.readFiles` reads it: a path the commit lacks is left out. */
const commitWith = (files: Record<string, string>) => ({
  readFiles: async (_dir: string, _commit: string, paths: readonly string[]) =>
    new Map(paths.flatMap((path) => (files[path] === undefined ? [] : [[path, Buffer.from(files[path])] as const]))),
});

describe("the repo's own merge request template (ADR-238)", () => {
  test("GitHub takes .github/pull_request_template.md before the root's and docs/", async () => {
    const vcs = commitWith({
      "PULL_REQUEST_TEMPLATE.md": "root",
      ".github/pull_request_template.md": "## Summary\n",
      "docs/pull_request_template.md": "docs",
    });

    expect(await readMergeRequestTemplate(vcs, "/w", "base", "github")).toEqual({
      path: ".github/pull_request_template.md",
      text: "## Summary\n",
    });
  });

  test("GitLab takes only its default template, never GitHub's", async () => {
    const vcs = commitWith({ ".github/pull_request_template.md": "## Summary\n", ".gitlab/merge_request_templates/Feature.md": "x" });

    expect(await readMergeRequestTemplate(vcs, "/w", "base", "gitlab")).toBeNull();
  });

  test("an empty template is none, and a long one is cut to what a description holds", async () => {
    expect(
      await readMergeRequestTemplate(commitWith({ ".gitlab/merge_request_templates/Default.md": " \n" }), "/w", "b", "gitlab"),
    ).toBeNull();

    const long = await readMergeRequestTemplate(commitWith({ "pull_request_template.md": "😀".repeat(5000) }), "/w", "b", "github");
    expect(long?.text).toBe("😀".repeat(MERGE_REQUEST_DESCRIPTION_MAX));
  });
});
