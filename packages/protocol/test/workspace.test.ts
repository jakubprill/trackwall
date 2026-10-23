import { describe, expect, test } from "bun:test";
import { RepoPath, workspaceApi } from "../src/index.ts";

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
});
