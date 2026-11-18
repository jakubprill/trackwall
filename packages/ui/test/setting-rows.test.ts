import { describe, expect, test } from "bun:test";
import type { WorkspaceSettings } from "@trackwall/protocol";
import { SETTING_ROWS, type SettingSources, settingRowOpen, settingsParts, settingValue } from "../src/lib/setting-rows.ts";
import { type SETTINGS_CATEGORIES, settingsCategory } from "../src/lib/settings-categories.ts";

/** The workspace settings of a computer where only the projects folder is set. */
const DEFAULTS: WorkspaceSettings = {
  projectsDir: "/home/me/dev",
  worktreesDir: null,
  worktreesDirProblem: null,
  defaultWorktreesDir: "/home/me/dev/.trackwall/worktrees",
  gitProgram: null,
  gitProgramProblem: null,
  sessionProfile: null,
  sessionProfileProblem: null,
  autoReview: { afterReport: false, rulesAfterReport: false },
  autoReviewProblem: null,
  supervisorModel: null,
  supervisorModelProblem: null,
  retryModel: null,
  retryModelProblem: null,
  supervisor: { changesCode: false },
  supervisorProblem: null,
  sandbox: null,
  sandboxProblem: null,
  taskTokenBudget: null,
  taskTokenBudgetProblem: null,
  runningTasksWarning: null,
  runningTasksWarningProblem: null,
  alwaysAllow: [],
  alwaysAllowProblem: null,
  configFile: "/home/me/.trackwall/workspace.yaml",
};

const sources = (settings: Partial<WorkspaceSettings> = {}): SettingSources => ({
  settings: { ...DEFAULTS, ...settings },
  settingsFailed: false,
  theme: "dark",
});

describe("Settings as folded rows (ADR-263)", () => {
  test("every section of Workspace, Agents and App is a folded row, and no section of the reports or of Get started is", () => {
    const rows = (category: (typeof SETTINGS_CATEGORIES)[number]) => category.sections.filter((s) => s in SETTING_ROWS);
    for (const id of ["workspace", "agents", "app"] as const)
      expect(rows(settingsCategory(id))).toEqual([...settingsCategory(id).sections]);
    for (const id of ["get-started", "repo-hosts", "usage", "files", "diagnostics"] as const)
      expect(rows(settingsCategory(id))).toEqual([]);
  });

  test("Agents shows its rows in three groups: Tasks, Supervisor, Model provider and other clients", () => {
    expect(settingsParts(settingsCategory("agents").sections)).toEqual([
      {
        kind: "rows",
        group: "Tasks",
        rows: ["sandbox", "auto-review", "always-allow", "task-token-budget", "running-tasks-warning", "retry-model", "java-navigation"],
      },
      { kind: "rows", group: "Supervisor", rows: ["supervisor-model", "supervisor-changes-code"] },
      { kind: "rows", group: "Model provider and other clients", rows: ["session-profile", "copilot-cli"] },
    ]);
  });

  test("a category of reports keeps its sections open, each on its own", () => {
    expect(settingsParts(settingsCategory("diagnostics").sections)).toEqual([
      { kind: "section", section: "doctor" },
      { kind: "section", section: "container-health" },
      { kind: "section", section: "daemon" },
      { kind: "section", section: "trackwall-errors" },
    ]);
  });

  test("a setting nobody changed says what applies without it", () => {
    const values = (["worktrees-dir", "git-program", "sandbox", "auto-review", "always-allow", "task-token-budget"] as const).map(
      (row) => settingValue(row, sources())?.text,
    );
    expect(values).toEqual(["default", "git from PATH", "default for this computer", "off", "none", "no budget"]);
    expect(settingValue("supervisor-model", sources())).toEqual({ text: "Copilot CLI's default", state: "default" });
  });

  test("a setting the user changed shows its value, marked as changed", () => {
    const changed = sources({
      supervisorModel: "gpt-5-mini",
      taskTokenBudget: 2_000_000,
      runningTasksWarning: 6,
      sandbox: { tasks: "all" },
      supervisor: { changesCode: true },
      alwaysAllow: [
        { repo: "shop", tool: "shell(mvn test)" },
        { repo: "shop", tool: "shell(git status)" },
      ],
    });
    expect(settingValue("supervisor-model", changed)).toEqual({ text: "gpt-5-mini", state: "changed" });
    expect(settingValue("task-token-budget", changed)).toEqual({ text: "2M", state: "changed" });
    expect(settingValue("running-tasks-warning", changed)).toEqual({ text: "6", state: "changed" });
    expect(settingValue("sandbox", changed)).toEqual({ text: "Every task", state: "changed" });
    expect(settingValue("supervisor-changes-code", changed)).toEqual({ text: "on", state: "changed" });
    expect(settingValue("always-allow", changed)).toEqual({ text: "2 tools", state: "changed" });
  });

  test("the automatic review names what runs on its own: the review, the rules check or both", () => {
    const of = (afterReport: boolean, rulesAfterReport: boolean) =>
      settingValue("auto-review", sources({ autoReview: { afterReport, rulesAfterReport } }))?.text;
    expect([of(true, false), of(false, true), of(true, true)]).toEqual(["on", "rules check", "review and rules check"]);
  });

  test("the projects folder shows its path without a mark, since it has no default to differ from", () => {
    expect(settingValue("projects-folder", sources())).toEqual({ text: "/home/me/dev", state: "default" });
  });

  test("a missing projects folder, a value workspace.yaml holds wrong and a workspace.yaml that cannot be read are problems", () => {
    expect(settingValue("projects-folder", sources({ projectsDir: null }))).toEqual({ text: "not set", state: "problem" });
    expect(settingValue("sandbox", sources({ sandboxProblem: 'sandbox.tasks: expected "auto", "all" or "off"' }))).toEqual({
      text: "cannot be read",
      state: "problem",
    });
    const failed: SettingSources = { settings: undefined, settingsFailed: true, theme: "dark" };
    expect(settingValue("projects-folder", failed)).toEqual({ text: "cannot be read", state: "problem" });
    expect(settingValue("git-program", failed)).toBeNull();
  });

  test("the theme shows the choice of this computer, and a setting only its form can read shows no value", () => {
    expect(settingValue("theme", sources())).toEqual({ text: "Dark", state: "default" });
    expect(settingValue("theme", { ...sources(), theme: "light" })).toEqual({ text: "Light", state: "changed" });
    expect(settingValue("start-at-sign-in", sources())).toBeNull();
  });

  test("a row is folded until the user opens it, except one whose value is a problem, which the user can still fold", () => {
    const fine = settingValue("git-program", sources());
    const problem = settingValue("projects-folder", sources({ projectsDir: null }));
    expect(settingRowOpen(undefined, fine)).toBe(false);
    expect(settingRowOpen(true, fine)).toBe(true);
    expect(settingRowOpen(undefined, problem)).toBe(true);
    expect(settingRowOpen(false, problem)).toBe(false);
    expect(settingRowOpen(undefined, null)).toBe(false);
  });

  test("every row says what the setting does in one sentence of at most 100 characters", () => {
    for (const { what } of Object.values(SETTING_ROWS)) {
      expect(what.length).toBeLessThanOrEqual(100);
      expect(what.endsWith(".")).toBe(true);
    }
  });
});
