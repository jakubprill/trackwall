import { countLabel, type WorkspaceSettings } from "@trackwall/protocol";
import { tokenCount } from "./copilot-usage.ts";
import type { HomeOnBar } from "./home-on-bar.ts";
import { SANDBOX_CHOICES, sandboxChoice } from "./sandbox.ts";
import type { SettingsSection } from "./settings-categories.ts";
import { DEFAULT_THEME_CHOICE, THEME_CHOICE_LABELS, type ThemeChoice } from "./theme.ts";

/**
 * Settings as folded rows (ADR-263): every setting of a category is one row with its name, one sentence on what it does
 * and its value now, and its form opens under it on a click. So a category shows what there is to set at a glance, and
 * nothing is open until asked, or until its value needs the user. The rows of a category stand in named groups.
 */

/** A setting's name, what it does in one sentence, and the group of its category it stands in. */
interface SettingRowText {
  title: string;
  what: string;
  group: string;
}

/** Every section that is a setting; the sections left out are reports, lists and "Get started", which stay open. */
export const SETTING_ROWS = {
  "projects-folder": { title: "Projects folder", what: "The folder with your repos.", group: "Folders" },
  "worktrees-dir": { title: "Task worktrees folder", what: "Where each task gets its own copy of a repo.", group: "Folders" },
  "git-program": { title: "Git program", what: "The git that reads your repos.", group: "Folders" },
  "local-config-store": { title: "Local config store", what: "Backs up the files your repos keep out of git.", group: "Backup" },
  "work-backup": {
    title: "Container work backup",
    what: "One file with the commits and changes only this container has.",
    group: "Backup",
  },
  "server-check": {
    title: "Check for new commits",
    what: "Ask your repos' servers every 15 minutes whether they have commits you have not fetched.",
    group: "Servers",
  },
  sandbox: { title: "Sandbox", what: "Which tasks run their commands closed inside their own worktree.", group: "Tasks" },
  "auto-review": { title: "Automatic review", what: "Review a task's changes when its agent reports its result.", group: "Tasks" },
  "always-allow": { title: "Always allowed in tasks", what: 'The tools you chose "Always allow" for, by repo.', group: "Tasks" },
  "task-token-budget": { title: "Token budget per task", what: "Stop a task after this many tokens.", group: "Tasks" },
  "running-tasks-warning": { title: "Running tasks warning", what: "Warn before more tasks than this run at once.", group: "Tasks" },
  "retry-model": { title: "Retry model", what: "A stronger model to retry a task that failed its verification.", group: "Tasks" },
  "java-navigation": { title: "Java navigation", what: "Let agents jump to Java definitions and usages.", group: "Tasks" },
  "supervisor-model": { title: "Supervisor model", what: "The model the supervisor runs on.", group: "Supervisor" },
  "supervisor-changes-code": {
    title: "Supervisor changes code",
    what: "Let the supervisor run commands and edit files itself.",
    group: "Supervisor",
  },
  "session-profile": {
    title: "Session profile",
    what: "A mise environment only sessions get, for a model provider of your own.",
    group: "Model provider and other clients",
  },
  "copilot-cli": {
    title: "Your own Copilot CLI",
    what: "Give Copilot CLI you start in a terminal Trackwall's tools. Sessions started here already have them.",
    group: "Model provider and other clients",
  },
  "start-at-sign-in": { title: "Start at sign-in", what: "Start Trackwall when you sign in.", group: "Desktop app" },
  "keep-screen-on": { title: "Keep the screen on", what: "Keep the screen from locking while agents work.", group: "Desktop app" },
  "remote-daemon": { title: "Daemon in a container", what: "Use a daemon that runs in a dev container.", group: "Desktop app" },
  updates: { title: "Updates", what: "Check for a newer version and install it.", group: "Desktop app" },
  "browser-notifications": {
    title: "Notifications in the browser",
    what: "Tell you in a browser tab when a session waits for you.",
    group: "Browser and VS Code",
  },
  "vscode-extension": { title: "VS Code extension", what: "Let the VS Code extension show your sessions.", group: "Browser and VS Code" },
  theme: { title: "Theme", what: "Dark, light or the same as the system.", group: "Look" },
  home: { title: "Home", what: "The 3D view of your repos and sessions: on the view bar or not, and how it draws them.", group: "Look" },
} as const satisfies Partial<Record<SettingsSection, SettingRowText>>;

export type SettingRowId = keyof typeof SETTING_ROWS;

function isSettingRow(section: SettingsSection): section is SettingRowId {
  return section in SETTING_ROWS;
}

/** A part of a category: a section that stays open, or a named group of folded rows. */
export type SettingsPart = { kind: "section"; section: SettingsSection } | { kind: "rows"; group: string; rows: SettingRowId[] };

/** A category's sections in their order, with the settings that follow one another in the same group put together. */
export function settingsParts(sections: readonly SettingsSection[]): SettingsPart[] {
  const parts: SettingsPart[] = [];
  for (const section of sections) {
    if (!isSettingRow(section)) {
      parts.push({ kind: "section", section });
      continue;
    }
    const group = SETTING_ROWS[section].group;
    const last = parts.at(-1);
    if (last?.kind === "rows" && last.group === group) last.rows.push(section);
    else parts.push({ kind: "rows", group, rows: [section] });
  }
  return parts;
}

/**
 * A setting's value in its folded row. `default`: nothing was chosen, and the text says what applies. `changed`: the
 * user's own value. `problem`: the value needs the user (the projects folder is not set, or `workspace.yaml` holds a
 * value that cannot be read), so the row stands open.
 */
export interface SettingValue {
  text: string;
  state: "default" | "changed" | "problem";
}

/** What the rows read their values from; a row whose source has not answered yet shows no value. */
export interface SettingSources {
  settings: WorkspaceSettings | undefined;
  /** The read of the workspace settings failed, for example on a `workspace.yaml` that cannot be parsed. */
  settingsFailed: boolean;
  theme: ThemeChoice;
  /** Whether the view bar shows Home (ADR-294), a choice of this computer like the theme. */
  homeOnBar: HomeOnBar;
}

const UNREADABLE = "cannot be read";

/** The user's own value, or what applies without one; a value `workspace.yaml` holds wrong comes first. */
function chosen(value: string | null, problem: string | null, fallback: string): SettingValue {
  if (problem !== null) return { text: UNREADABLE, state: "problem" };
  return value === null ? { text: fallback, state: "default" } : { text: value, state: "changed" };
}

function onOff(on: boolean, problem: string | null): SettingValue {
  if (problem !== null) return { text: UNREADABLE, state: "problem" };
  return on ? { text: "on", state: "changed" } : { text: "off", state: "default" };
}

function autoReviewValue({ autoReview, autoReviewProblem }: WorkspaceSettings): SettingValue {
  if (autoReview.afterReport && autoReview.rulesAfterReport && autoReviewProblem === null)
    return { text: "review and rules check", state: "changed" };
  if (autoReview.rulesAfterReport && autoReviewProblem === null) return { text: "rules check", state: "changed" };
  return onOff(autoReview.afterReport, autoReviewProblem);
}

function sandboxValue({ sandbox, sandboxProblem }: WorkspaceSettings): SettingValue {
  const label = SANDBOX_CHOICES.find((c) => c.choice === sandboxChoice(sandbox))?.label ?? null;
  return chosen(sandbox === null ? null : label, sandboxProblem, "default for this computer");
}

/** The values that come from `workspace.yaml`, each from the one read of the workspace settings. */
const WORKSPACE_VALUES: Partial<Record<SettingRowId, (settings: WorkspaceSettings) => SettingValue>> = {
  // The only setting without a default: while it is missing the row says so and stands open.
  "projects-folder": (s) => (s.projectsDir === null ? { text: "not set", state: "problem" } : { text: s.projectsDir, state: "default" }),
  "worktrees-dir": (s) => chosen(s.worktreesDir, s.worktreesDirProblem, "default"),
  "git-program": (s) => chosen(s.gitProgram, s.gitProgramProblem, "git from PATH"),
  // On by default, so turning it off is the change.
  "server-check": (s) => {
    if (s.serverCheckProblem !== null) return { text: UNREADABLE, state: "problem" };
    return s.serverCheck ? { text: "every 15 minutes", state: "default" } : { text: "off", state: "changed" };
  },
  sandbox: sandboxValue,
  "auto-review": autoReviewValue,
  "always-allow": (s) =>
    chosen(
      s.alwaysAllow.length === 0 ? null : countLabel(s.alwaysAllow.length, { one: "tool", other: "tools" }),
      s.alwaysAllowProblem,
      "none",
    ),
  "task-token-budget": (s) =>
    chosen(s.taskTokenBudget === null ? null : tokenCount(s.taskTokenBudget), s.taskTokenBudgetProblem, "no budget"),
  "running-tasks-warning": (s) =>
    chosen(s.runningTasksWarning === null ? null : String(s.runningTasksWarning), s.runningTasksWarningProblem, "computer's default"),
  "retry-model": (s) => chosen(s.retryModel, s.retryModelProblem, "none"),
  "supervisor-model": (s) => chosen(s.supervisorModel, s.supervisorModelProblem, "Copilot CLI's default"),
  "supervisor-changes-code": (s) => onOff(s.supervisor.changesCode, s.supervisorProblem),
  "session-profile": (s) => chosen(s.sessionProfile, s.sessionProfileProblem, "none"),
};

/** The value a row shows; `null` for a setting whose value only its form reads (the desktop shell, the browser, an install). */
export function settingValue(row: SettingRowId, { settings, settingsFailed, theme, homeOnBar }: SettingSources): SettingValue | null {
  // The form of the projects folder is where a broken `workspace.yaml` is explained and fixed, so its row opens for it.
  if (row === "projects-folder" && settingsFailed) return { text: UNREADABLE, state: "problem" };
  if (row === "theme") return { text: THEME_CHOICE_LABELS[theme], state: theme === DEFAULT_THEME_CHOICE ? "default" : "changed" };
  if (row === "home") return { text: homeOnBar, state: homeOnBar === "hidden" ? "default" : "changed" };
  const read = WORKSPACE_VALUES[row];
  return read && settings ? read(settings) : null;
}

/** Whether a row shows its form: as the user left it, and until they touch it, open only when its value needs them. */
export function settingRowOpen(toggled: boolean | undefined, value: SettingValue | null): boolean {
  return toggled ?? value?.state === "problem";
}
