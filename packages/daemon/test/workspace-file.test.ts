import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkspaceFile } from "../src/modules/workspace/workspace-file.ts";

const tempFile = () => join(mkdtempSync(join(tmpdir(), "trackwall-wsf-")), "workspace.yaml");

describe("workspace.yaml", () => {
  test("a missing file is an unset projects folder, and the first setting creates the file", () => {
    const path = tempFile();
    const file = new WorkspaceFile(path);
    expect(file.projectsDir()).toBeNull();

    // A full path on every system: on Windows `/projects` has no drive letter.
    const dir = resolve("/projects");
    file.setProjectsDir(dir);

    expect(file.projectsDir()).toBe(dir);
    expect(readFileSync(path, "utf8")).toBe(`projectsDir: ${dir}\n`);
  });

  test("an empty projectsDir key is an unset folder", () => {
    const path = tempFile();
    writeFileSync(path, "# my workspace\nprojectsDir:\n");
    expect(new WorkspaceFile(path).projectsDir()).toBeNull();
  });

  test("changing the folder keeps comments and other keys", () => {
    const path = tempFile();
    writeFileSync(path, "# my workspace\nports:\n  api: 8080\n# the repos are here\nprojectsDir: /old\n");
    const file = new WorkspaceFile(path);

    file.setProjectsDir("/new");

    expect(readFileSync(path, "utf8")).toBe("# my workspace\nports:\n  api: 8080\n# the repos are here\nprojectsDir: /new\n");
  });

  test("the repos list from version 0.2.0 is not read, but stays in the file", () => {
    const path = tempFile();
    writeFileSync(path, "repos:\n  - id: api\n    path: /repos/api\n");
    const file = new WorkspaceFile(path);
    expect(file.projectsDir()).toBeNull();

    file.setProjectsDir("/projects");

    expect(readFileSync(path, "utf8")).toBe("repos:\n  - id: api\n    path: /repos/api\nprojectsDir: /projects\n");
  });

  test("a relative path or one with ~ is a configuration error, not a silent dependence on the daemon's directory", () => {
    const path = tempFile();
    writeFileSync(path, "projectsDir: ~/projects\n");
    expect(() => new WorkspaceFile(path).projectsDir()).toThrow(
      expect.objectContaining({ code: "invalid_config", message: expect.stringContaining("must be a full path") }),
    );
  });

  test("a key read again after the file changed by hand gives the new value, and a broken edit is an error at once", () => {
    const path = tempFile();
    const file = new WorkspaceFile(path);
    // Full paths of this system: on Windows `/old` has no drive and is not one.
    const [oldDir, newDir] = [resolve("/old"), resolve("/new")];
    writeFileSync(path, `projectsDir: ${JSON.stringify(oldDir)}\n`);
    expect(file.projectsDir()).toBe(oldDir);

    writeFileSync(path, `projectsDir: ${JSON.stringify(newDir)}\n`);
    expect(file.projectsDir()).toBe(newDir);

    writeFileSync(path, "projectsDir: [unclosed\n");
    expect(() => file.projectsDir()).toThrow(expect.objectContaining({ code: "invalid_config" }));
  });

  test("an invalid file gives invalid_config with the path and a description", () => {
    const path = tempFile();
    writeFileSync(path, "projectsDir: [\n");
    expect(() => new WorkspaceFile(path).projectsDir()).toThrow(
      expect.objectContaining({ code: "invalid_config", message: expect.stringContaining(path) }),
    );

    writeFileSync(path, "- /projects\n");
    expect(() => new WorkspaceFile(path).projectsDir()).toThrow(
      expect.objectContaining({ message: expect.stringContaining("map of keys") }),
    );
  });
  test("a bad entry in repoHosts is a configuration error of that key and does not break the projects folder", () => {
    const path = tempFile();
    const dir = resolve("/projects");
    writeFileSync(path, `projectsDir: ${JSON.stringify(dir)}\nrepoHosts:\n  - kind: gitlab\n    host: https://gitlab.example.com\n`);
    const file = new WorkspaceFile(path);

    expect(() => file.repoHosts()).toThrow(
      expect.objectContaining({ code: "invalid_config", message: expect.stringContaining("repoHosts") }),
    );
    expect(file.projectsDir()).toBe(dir);
  });

  test("the same hosting twice in repoHosts is a configuration error", () => {
    const path = tempFile();
    writeFileSync(path, "repoHosts:\n  - { kind: gitlab, host: gitlab.example.com }\n  - { kind: gitlab, host: GitLab.example.com }\n");
    expect(() => new WorkspaceFile(path).repoHosts()).toThrow(expect.objectContaining({ code: "invalid_config" }));
  });

  test("dayStart.prompt is the user's addition to the day start, a missing key is none, and an unknown field is a configuration error of that key", () => {
    const path = tempFile();
    expect(new WorkspaceFile(path).dayStartSettings()).toBeNull();

    writeFileSync(path, "dayStart:\n  prompt: |\n    Check my open issues.\n    Then the merge requests waiting for my review.\n");
    expect(new WorkspaceFile(path).dayStartSettings()).toEqual({
      prompt: "Check my open issues.\nThen the merge requests waiting for my review.",
    });

    writeFileSync(path, "dayStart:\n  promt: Check my open issues.\n");
    expect(() => new WorkspaceFile(path).dayStartSettings()).toThrow(
      expect.objectContaining({ code: "invalid_config", message: expect.stringContaining("dayStart") }),
    );
  });
  test("supervisor.changesCode lets the supervisor change code, a missing key does not, and a misspelt field is a configuration error of that key", () => {
    const path = tempFile();
    expect(new WorkspaceFile(path).supervisorSettings()).toEqual({ changesCode: false });

    writeFileSync(path, "supervisor:\n  changesCode: true\n");
    expect(new WorkspaceFile(path).supervisorSettings()).toEqual({ changesCode: true });

    writeFileSync(path, "supervisor:\n  changeCode: true\n");
    expect(() => new WorkspaceFile(path).supervisorSettings()).toThrow(
      expect.objectContaining({ code: "invalid_config", message: expect.stringContaining("supervisor") }),
    );
  });
  test("agentSecrets names the secrets from mise a session's tools get, none without the key, and a name that is not a variable is a configuration error", () => {
    const path = tempFile();
    expect(new WorkspaceFile(path).agentSecrets()).toEqual([]);

    writeFileSync(path, "agentSecrets:\n  - JIRA_TOKEN\n  - GITLAB_TOKEN\n");
    expect(new WorkspaceFile(path).agentSecrets()).toEqual(["JIRA_TOKEN", "GITLAB_TOKEN"]);

    writeFileSync(path, "agentSecrets: JIRA_TOKEN,GITLAB_TOKEN\n");
    expect(() => new WorkspaceFile(path).agentSecrets()).toThrow(
      expect.objectContaining({ code: "invalid_config", message: expect.stringContaining("agentSecrets") }),
    );
    writeFileSync(path, "agentSecrets: [JIRA_TOKEN,GITLAB_TOKEN]\n");
    expect(new WorkspaceFile(path).agentSecrets()).toEqual(["JIRA_TOKEN", "GITLAB_TOKEN"]);
    writeFileSync(path, "agentSecrets: ['JIRA TOKEN']\n");
    expect(() => new WorkspaceFile(path).agentSecrets()).toThrow(expect.objectContaining({ code: "invalid_config" }));
  });
});
