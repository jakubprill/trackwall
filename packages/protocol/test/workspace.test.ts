import { describe, expect, test } from "bun:test";
import { HostName, RemoteRepoName, RepoHosts, RepoPath, workspaceApi } from "../src/index.ts";

describe("workspace contract", () => {
  test("a path in a repo does not leave the commit's tree and has no control characters", () => {
    for (const ok of ["", "src", "src/a b.ts", "win\\file.txt"]) expect(RepoPath.safeParse(ok).success).toBe(true);
    for (const bad of ["..", "src/../x", "./src", "/src", "src/", "a\nb", "a\0b"]) expect(RepoPath.safeParse(bad).success).toBe(false);
  });

  test("an action body accepts no unknown fields", () => {
    expect(workspaceApi.overview.request.safeParse({ repo: "api", extra: 1 }).success).toBe(false);
  });

  test("the tree accepts file names as git returns them, also with a backslash", () => {
    expect(workspaceApi.tree.data.safeParse([{ name: "win\\file.txt", path: "win\\file.txt", kind: "file", size: 1 }]).success).toBe(true);
  });

  test("a full repo name from a repo host has at least two segments, and none starts with - or .", () => {
    for (const ok of ["me/repo", "group/subgroup/project", "a_b/c.d-e"]) expect(RemoteRepoName.safeParse(ok).success).toBe(true);
    for (const bad of ["repo", "me/-x", "me/..", "../me/repo", "me//repo", "me/repo/", "me/re po"])
      expect(RemoteRepoName.safeParse(bad).success).toBe(false);
  });

  test("a host name without scheme and path, stored in lowercase", () => {
    expect(HostName.parse("GitLab.Example.com")).toBe("gitlab.example.com");
    expect(HostName.safeParse("git.local:8443").success).toBe(true);
    for (const bad of ["https://gitlab.example.com", "gitlab.example.com/group", "", "-x.com"])
      expect(HostName.safeParse(bad).success).toBe(false);
  });

  test("the list of repo hosts does not accept the same repo host twice, also written in different case", () => {
    const gitlab = { kind: "gitlab", host: "gitlab.example.com" };
    expect(RepoHosts.safeParse([gitlab, { kind: "github", host: "github.com" }]).success).toBe(true);
    expect(RepoHosts.safeParse([gitlab, { kind: "gitlab", host: "GitLab.example.com" }]).success).toBe(false);
  });
});
