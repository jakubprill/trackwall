import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigEntryId } from "@trackwall/protocol";
import { createFacade, HOSTING_CLIS } from "../src/facade.ts";
import { vscodeUrl } from "../src/infra/editor-url.ts";

/**
 * The view of every config file (ADR-108) through the real facade, on a fresh state folder and projects folder, with
 * Copilot CLI's folder in `COPILOT_HOME` and no mise.
 */
function setup() {
  const home = mkdtempSync(join(tmpdir(), "trackwall-config-home-"));
  const projects = mkdtempSync(join(tmpdir(), "trackwall-config-projects-"));
  const copilotHome = mkdtempSync(join(tmpdir(), "trackwall-config-copilot-"));
  const opened: string[] = [];
  const shown: string[] = [];
  const facade = createFacade({
    home,
    homeFrom: "env",
    openUrl: (url) => opened.push(url),
    openFolder: (dir) => shown.push(dir),
    miseCommand: ["trackwall-test-no-mise"],
    copilotCommand: ["trackwall-test-no-copilot"],
    version: "0.0.0-test",
    sessionHook: () => ({ url: "http://127.0.0.1:9/hooks/unused", headers: {} }),
    sessionMcpServer: () => ({ url: "http://127.0.0.1:9/mcp", headers: {} }),
    hostingClis: HOSTING_CLIS,
    userEnv: async () => ({ ...process.env, COPILOT_HOME: copilotHome }),
    log: () => {},
  });
  return { facade, home, projects, copilotHome, opened, shown };
}

describe("config files", () => {
  test("every entry comes in a fixed order with its path and state, and each key says whether the file sets it", async () => {
    const { facade, home, projects, copilotHome } = setup();
    await facade.workspace.setProjectsDir(projects);
    const workspaceFile = join(home, "workspace.yaml");
    writeFileSync(workspaceFile, `${readFileSync(workspaceFile, "utf8")}agentSecrets: [GITLAB_TOKEN]\n`);
    writeFileSync(join(home, "tasks.json"), "[]");
    writeFileSync(join(copilotHome, "config.json"), JSON.stringify({ trustedFolders: [projects] }));

    const report = await facade.configFiles.list();

    expect(report.stateDir).toEqual({ path: home, from: "env" });
    expect(report.places).toEqual({ state: home, projects, copilot: copilotHome });
    expect(report.entries.map((e) => e.id)).toEqual(ConfigEntryId.options);
    const entry = (id: ConfigEntryId) => report.entries.find((e) => e.id === id);
    expect(entry("workspace-file")).toEqual({
      id: "workspace-file",
      name: "workspace.yaml",
      path: workspaceFile,
      state: "present",
      detail: "2 of 9 keys set in the file",
    });
    expect(entry("tasks-file")).toEqual({
      id: "tasks-file",
      name: "tasks.json",
      path: join(home, "tasks.json"),
      state: "present",
      detail: "2 B",
    });
    expect(entry("day-start-file")).toEqual({
      id: "day-start-file",
      name: "day-start.json",
      path: join(home, "day-start.json"),
      state: "missing",
      detail: null,
    });
    expect(entry("task-worktrees-dir")?.path).toBe(join(projects, ".trackwall-worktrees"));
    expect(entry("removed-repos-dir")).toEqual({
      id: "removed-repos-dir",
      name: ".trackwall-removed",
      path: join(projects, ".trackwall-removed"),
      state: "missing",
      detail: null,
    });
    expect(entry("projects-mise-config")).toEqual({
      id: "projects-mise-config",
      name: "mise.toml",
      path: join(projects, "mise.toml"),
      state: "missing",
      detail: null,
    });
    expect(entry("copilot-config")).toEqual({
      id: "copilot-config",
      name: "config.json",
      path: join(copilotHome, "config.json"),
      state: "present",
      detail: `trusts ${projects}`,
    });
    expect(report.workspaceKeys.map((k) => [k.key, k.from, k.value, k.line])).toEqual([
      ["projectsDir", "file", projects, 1],
      ["worktreesDir", "default", join(projects, ".trackwall-worktrees"), null],
      ["repoHosts", "default", "none", null],
      ["toolPermissions", "default", "none", null],
      ["agentSecrets", "file", "GITLAB_TOKEN", 2],
      ["supervisor", "default", "changesCode: false", null],
      ["repoTags", "default", "none", null],
      ["dayStart", "default", "not set", null],
      ["graph", "default", "0 package aliases, 0 app aliases, 0 edges", null],
    ]);
  });

  test("a key written wrong by hand is invalid with its line, and the other keys still read", async () => {
    const { facade, home, projects } = setup();
    writeFileSync(
      join(home, "workspace.yaml"),
      `projectsDir: ${JSON.stringify(projects)}\n\n# packages built elsewhere\ngraph:\n  packages: [orders-client]\nsupervisor:\n  changesCode: true\n`,
    );

    const report = await facade.configFiles.list();

    expect(report.entries.find((e) => e.id === "workspace-file")).toMatchObject({
      state: "invalid",
      detail: "1 key cannot be read: graph (line 4)",
    });
    const graph = report.workspaceKeys.find((k) => k.key === "graph");
    expect(graph).toMatchObject({ from: "file", value: null, line: 4 });
    expect(graph?.problem).toContain("packages");
    expect(report.workspaceKeys.find((k) => k.key === "supervisor")).toEqual({
      key: "supervisor",
      from: "file",
      value: "changesCode: true",
      line: 6,
      problem: null,
    });
  });

  test("a key Trackwall does not read, such as a typo, is listed with its line and leaves the file readable", async () => {
    const { facade, home, projects } = setup();
    writeFileSync(join(home, "workspace.yaml"), `projectsDir: ${JSON.stringify(projects)}\ntoolPermission:\n  - allow: [shell(mvn:*)]\n`);

    const report = await facade.configFiles.list();

    expect(report.unknownWorkspaceKeys).toEqual([{ name: "toolPermission", line: 2 }]);
    expect(report.entries.find((e) => e.id === "workspace-file")).toMatchObject({
      state: "present",
      detail: "Trackwall does not read 1 key: toolPermission (line 2)",
    });
  });

  test("a workspace.yaml that is not YAML is invalid as a whole, and the list still comes without a projects folder", async () => {
    const { facade, home } = setup();
    writeFileSync(join(home, "workspace.yaml"), "projectsDir: [unclosed\n");

    const report = await facade.configFiles.list();

    const file = report.entries.find((e) => e.id === "workspace-file");
    expect(file?.state).toBe("invalid");
    expect(file?.detail).toContain("workspace.yaml is invalid");
    expect(report.workspaceKeys).toEqual([]);
    expect(report.places.projects).toBeNull();
    expect(report.entries.find((e) => e.id === "local-config-store")).toEqual({
      id: "local-config-store",
      name: ".trackwall-local",
      path: null,
      state: "missing",
      detail: "set the projects folder first",
    });
  });

  test("a folder holds its count of items, and the removed repos folder its count of repos", async () => {
    const { facade, home, projects } = setup();
    await facade.workspace.setProjectsDir(projects);
    mkdirSync(join(home, "cards"));
    writeFileSync(join(home, "cards", "a.json"), "{}");
    writeFileSync(join(home, "cards", "b.json"), "{}");
    mkdirSync(join(projects, ".trackwall-removed", "old-api"), { recursive: true });
    mkdirSync(join(projects, ".trackwall-worktrees", "orders", "fix-login"), { recursive: true });
    mkdirSync(join(projects, ".trackwall-worktrees", "orders", "add-export"), { recursive: true });

    const entries = (await facade.configFiles.list()).entries;

    expect(entries.find((e) => e.id === "cards-dir")?.detail).toBe("2 items");
    expect(entries.find((e) => e.id === "removed-repos-dir")?.detail).toBe("1 repo");
    expect(entries.find((e) => e.id === "task-worktrees-dir")?.detail).toBe("2 worktrees");
  });

  test("a file opens in the editor and shows its folder; a folder only shows itself, and a missing entry is not found", async () => {
    const { facade, home, projects, opened, shown } = setup();
    await facade.workspace.setProjectsDir(projects);
    mkdirSync(join(home, "logs"), { recursive: true });

    await facade.configFiles.openInEditor("workspace-file");
    await facade.configFiles.showInFolder("workspace-file");
    await facade.configFiles.showInFolder("logs-dir");

    expect(opened).toEqual([vscodeUrl(join(home, "workspace.yaml"))]);
    expect(shown).toEqual([home, join(home, "logs")]);
    await expect(facade.configFiles.openInEditor("logs-dir")).rejects.toMatchObject({ code: "bad_request" });
    await expect(facade.configFiles.showInFolder("removed-repos-dir")).rejects.toMatchObject({ code: "not_found" });
  });
});
