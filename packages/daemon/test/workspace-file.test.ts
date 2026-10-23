import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";

const tempFile = () => join(mkdtempSync(join(tmpdir(), "pitwall-wsf-")), "workspace.yaml");

describe("workspace.yaml", () => {
  test("brak pliku to pusty workspace, a pierwsze dodanie tworzy plik", () => {
    const path = tempFile();
    const file = new WorkspaceFile(path);
    expect(file.repos()).toEqual([]);

    file.add({ id: "api", path: "/repos/api" });

    expect(file.repos()).toEqual([{ id: "api", path: "/repos/api" }]);
  });

  test("dodanie i usunięcie zachowuje komentarze i inne klucze", () => {
    const path = tempFile();
    writeFileSync(path, "# mój workspace\nports:\n  api: 8080\nrepos:\n  # backend\n  - id: api\n    path: /repos/api\n");
    const file = new WorkspaceFile(path);

    file.add({ id: "web", path: "/repos/web" });
    file.remove("api");

    const text = readFileSync(path, "utf8");
    expect(text).toContain("# mój workspace");
    expect(text).toContain("api: 8080");
    expect(file.repos()).toEqual([{ id: "web", path: "/repos/web" }]);
    expect(file.remove("nie-ma")).toBe(false);
  });

  test("niepoprawny plik daje invalid_config ze ścieżką i opisem", () => {
    const path = tempFile();
    writeFileSync(path, "repos:\n  - id: Wielkie Litery\n    path: /x\n");
    expect(() => new WorkspaceFile(path).repos()).toThrow(
      expect.objectContaining({ code: "invalid_config", message: expect.stringContaining("repos.0.id") }),
    );

    writeFileSync(path, "repos: [\n");
    expect(() => new WorkspaceFile(path).repos()).toThrow(expect.objectContaining({ code: "invalid_config" }));

    writeFileSync(path, "repos:\n  - { id: a, path: /a }\n  - { id: a, path: /b }\n");
    expect(() => new WorkspaceFile(path).repos()).toThrow(expect.objectContaining({ message: expect.stringContaining("unikalne") }));
  });
});
