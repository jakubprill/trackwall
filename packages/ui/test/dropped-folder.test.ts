import { describe, expect, test } from "bun:test";
import { dropOutcome, extraItemsNote } from "../src/lib/dropped-folder.ts";

describe("dropped folder", () => {
  test("a listed repo and the current projects folder open Repos without asking", () => {
    expect(dropOutcome({ kind: "listed-repo", repo: "shop" })).toEqual({ kind: "open-repos", repo: "shop" });
    expect(dropOutcome({ kind: "folder-with-repos", path: "/Users/me/Projects", repos: 3, current: true })).toEqual({ kind: "open-repos" });
  });

  test("another folder with repos is offered as the projects folder", () => {
    expect(dropOutcome({ kind: "folder-with-repos", path: "/Users/me/Work", repos: 1, current: false })).toEqual({
      kind: "prompt",
      message:
        "/Users/me/Work has 1 git repo directly inside it. Use it as the projects folder? The Repos view then lists its repos instead of the current ones.",
      projectsDir: { path: "/Users/me/Work", label: "Use as the projects folder" },
    });
  });

  test("a repo from elsewhere offers the folder that holds it", () => {
    expect(dropOutcome({ kind: "repo-elsewhere", path: "C:\\Work\\api", parent: "C:\\Work", parentRepos: 4 })).toEqual({
      kind: "prompt",
      message:
        "C:\\Work\\api is not in the projects folder. Trackwall lists the repos directly inside one folder; the folder that holds this repo, C:\\Work, has 4 git repos.",
      projectsDir: { path: "C:\\Work", label: "Use its folder as the projects folder" },
    });
  });

  test("a folder without repos and a file only say what they are", () => {
    expect(dropOutcome({ kind: "no-repos", path: "/tmp/notes" })).toEqual({
      kind: "prompt",
      message: "/tmp/notes is not a git repo and has no git repos directly inside it.",
    });
    expect(dropOutcome({ kind: "file", path: "/tmp/a.txt" })).toMatchObject({
      kind: "prompt",
      message: expect.stringContaining("session terminal"),
    });
  });

  test("more than one dropped item notes that only the first is used", () => {
    expect(extraItemsNote(["/a"])).toBeUndefined();
    expect(extraItemsNote(["/a", "/b"])).toBe("Only the first dropped item is used; 1 other was left out.");
    expect(extraItemsNote(["/a", "/b", "/c"])).toBe("Only the first dropped item is used; 2 others were left out.");
  });
});
