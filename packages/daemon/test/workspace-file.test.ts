import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";

const tempFile = () => join(mkdtempSync(join(tmpdir(), "trackwall-wsf-")), "workspace.yaml");

describe("workspace.yaml", () => {
  test("brak pliku to nieustawiony folder z projektami, a pierwsze ustawienie tworzy plik", () => {
    const path = tempFile();
    const file = new WorkspaceFile(path);
    expect(file.projectsDir()).toBeNull();

    // Pełna ścieżka na każdym systemie: na Windowsie `/projekty` nie ma litery dysku.
    const dir = resolve("/projekty");
    file.setProjectsDir(dir);

    expect(file.projectsDir()).toBe(dir);
    expect(readFileSync(path, "utf8")).toBe(`projectsDir: ${dir}\n`);
  });

  test("pusty klucz projectsDir to nieustawiony folder", () => {
    const path = tempFile();
    writeFileSync(path, "# mój workspace\nprojectsDir:\n");
    expect(new WorkspaceFile(path).projectsDir()).toBeNull();
  });

  test("zmiana folderu zachowuje komentarze i inne klucze", () => {
    const path = tempFile();
    writeFileSync(path, "# mój workspace\nports:\n  api: 8080\n# tu są repo\nprojectsDir: /stare\n");
    const file = new WorkspaceFile(path);

    file.setProjectsDir("/nowe");

    expect(readFileSync(path, "utf8")).toBe("# mój workspace\nports:\n  api: 8080\n# tu są repo\nprojectsDir: /nowe\n");
  });

  test("lista repos z wersji 0.2.0 nie jest czytana, ale zostaje w pliku", () => {
    const path = tempFile();
    writeFileSync(path, "repos:\n  - id: api\n    path: /repos/api\n");
    const file = new WorkspaceFile(path);
    expect(file.projectsDir()).toBeNull();

    file.setProjectsDir("/projekty");

    expect(readFileSync(path, "utf8")).toBe("repos:\n  - id: api\n    path: /repos/api\nprojectsDir: /projekty\n");
  });

  test("ścieżka względna albo z ~ jest błędem konfiguracji, a nie cichym zależeniem od katalogu daemona", () => {
    const path = tempFile();
    writeFileSync(path, "projectsDir: ~/projekty\n");
    expect(() => new WorkspaceFile(path).projectsDir()).toThrow(
      expect.objectContaining({ code: "invalid_config", message: expect.stringContaining("must be a full path") }),
    );
  });

  test("niepoprawny plik daje invalid_config ze ścieżką i opisem", () => {
    const path = tempFile();
    writeFileSync(path, "projectsDir: [\n");
    expect(() => new WorkspaceFile(path).projectsDir()).toThrow(
      expect.objectContaining({ code: "invalid_config", message: expect.stringContaining(path) }),
    );

    writeFileSync(path, "- /projekty\n");
    expect(() => new WorkspaceFile(path).projectsDir()).toThrow(
      expect.objectContaining({ message: expect.stringContaining("map of keys") }),
    );
  });
  test("zły wpis w repoHosts jest błędem konfiguracji tego klucza i nie psuje folderu z projektami", () => {
    const path = tempFile();
    const dir = resolve("/projekty");
    writeFileSync(path, `projectsDir: ${JSON.stringify(dir)}\nrepoHosts:\n  - kind: gitlab\n    host: https://gitlab.example.com\n`);
    const file = new WorkspaceFile(path);

    expect(() => file.repoHosts()).toThrow(
      expect.objectContaining({ code: "invalid_config", message: expect.stringContaining("repoHosts") }),
    );
    expect(file.projectsDir()).toBe(dir);
  });

  test("ten sam hosting dwa razy w repoHosts jest błędem konfiguracji", () => {
    const path = tempFile();
    writeFileSync(path, "repoHosts:\n  - { kind: gitlab, host: gitlab.example.com }\n  - { kind: gitlab, host: GitLab.example.com }\n");
    expect(() => new WorkspaceFile(path).repoHosts()).toThrow(expect.objectContaining({ code: "invalid_config" }));
  });
});
