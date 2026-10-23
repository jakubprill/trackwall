import { describe, expect, test } from "bun:test";
import { HostName, RemoteRepoName, RepoHosts, RepoPath, workspaceApi } from "../src/index.ts";

describe("kontrakt workspace", () => {
  test("ścieżka w repo nie wychodzi poza drzewo commita i nie zawiera znaków sterujących", () => {
    for (const ok of ["", "src", "src/a b.ts", "win\\styl.txt"]) expect(RepoPath.safeParse(ok).success).toBe(true);
    for (const bad of ["..", "src/../x", "./src", "/src", "src/", "a\nb", "a\0b"]) expect(RepoPath.safeParse(bad).success).toBe(false);
  });

  test("ciało akcji nie przyjmuje nieznanych pól", () => {
    expect(workspaceApi.overview.request.safeParse({ repo: "api", nadmiar: 1 }).success).toBe(false);
  });

  test("drzewo przyjmuje nazwy plików, jakie zwraca git, także z ukośnikiem wstecznym", () => {
    expect(workspaceApi.tree.data.safeParse([{ name: "win\\styl.txt", path: "win\\styl.txt", kind: "file", size: 1 }]).success).toBe(true);
  });

  test("pełna nazwa repo z hostingu ma co najmniej dwa segmenty i żaden nie zaczyna się od - ani .", () => {
    for (const ok of ["ja/repo", "grupa/podgrupa/projekt", "a_b/c.d-e"]) expect(RemoteRepoName.safeParse(ok).success).toBe(true);
    for (const bad of ["repo", "ja/-x", "ja/..", "../ja/repo", "ja//repo", "ja/repo/", "ja/re po"])
      expect(RemoteRepoName.safeParse(bad).success).toBe(false);
  });

  test("nazwa hosta bez schematu i ścieżki, zapisywana małymi literami", () => {
    expect(HostName.parse("GitLab.Example.com")).toBe("gitlab.example.com");
    expect(HostName.safeParse("git.local:8443").success).toBe(true);
    for (const bad of ["https://gitlab.example.com", "gitlab.example.com/grupa", "", "-x.com"])
      expect(HostName.safeParse(bad).success).toBe(false);
  });

  test("lista hostingów nie przyjmuje tego samego hostingu dwa razy, także pisanego innymi literami", () => {
    const gitlab = { kind: "gitlab", host: "gitlab.example.com" };
    expect(RepoHosts.safeParse([gitlab, { kind: "github", host: "github.com" }]).success).toBe(true);
    expect(RepoHosts.safeParse([gitlab, { kind: "gitlab", host: "GitLab.example.com" }]).success).toBe(false);
  });
});
