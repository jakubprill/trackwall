/**
 * The categories of Settings (ADR-102), in the order of its list. Each holds the sections that belong together, so the
 * view shows a few at a time instead of one long column, and what you set, the state you glance at and the diagnostics
 * for when something does not work stay apart. A category of reports rather than settings is `wide` (ADR-212): its
 * sections take the whole width, as their tables and lists side by side need it. The list has three groups (ADR-262):
 * "Get started" on its own, the categories you set, and the ones you only read.
 */
export const SETTINGS_CATEGORIES = [
  {
    id: "get-started",
    label: "Get started",
    description: "What Trackwall needs before your first session. Everything else in Settings has a default that works.",
    sections: ["get-started"],
    wide: false,
    group: "start",
  },
  {
    id: "workspace",
    label: "Workspace",
    description: "Where your repos and task worktrees live, which git reads them, and the backup of their local config.",
    sections: ["folders", "local-config-store"],
    wide: false,
    group: "settings",
  },
  {
    id: "repo-hosts",
    label: "Repo hosts",
    description: "The GitLab and GitHub hosts the Repos view searches and clones from.",
    sections: ["repo-hosts"],
    wide: false,
    group: "settings",
  },
  {
    id: "agents",
    label: "Agents",
    description: "What Copilot CLI gets from Trackwall, and how its sessions start.",
    sections: [
      "copilot-cli",
      "session-profile",
      "supervisor-model",
      "supervisor-changes-code",
      "retry-model",
      "task-token-budget",
      "running-tasks-warning",
      "always-allow",
      "sandbox",
      "auto-review",
      "java-navigation",
    ],
    wide: false,
    group: "settings",
  },
  {
    id: "app",
    label: "App",
    description: "The desktop app on this computer, Trackwall in a browser tab, and the VS Code extension.",
    sections: [
      "start-at-sign-in",
      "keep-screen-on",
      "remote-daemon",
      "browser-notifications",
      "vscode-extension",
      "updates",
      "theme",
      "home-scene",
    ],
    wide: false,
    group: "settings",
  },
  {
    id: "usage",
    label: "Usage",
    description:
      "What Copilot CLI used on this computer, how each model did on your tasks, and every call agents made to Trackwall's tools.",
    sections: ["copilot-usage", "model-stats", "mcp-calls"],
    wide: true,
    group: "reports",
  },
  {
    id: "files",
    label: "Files",
    description:
      "Every file and folder Trackwall reads or writes on this computer: what it is for, where it is and what is in it. Trackwall changes them only through Settings; the rest you edit by hand.",
    sections: ["config-files", "local-config-repos"],
    wide: false,
    group: "reports",
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    description: "Where to look when something does not work.",
    sections: ["doctor", "daemon", "trackwall-errors"],
    wide: false,
    group: "reports",
  },
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number]["id"];
export type SettingsSection = (typeof SETTINGS_CATEGORIES)[number]["sections"][number];

export type SettingsGroup = (typeof SETTINGS_CATEGORIES)[number]["group"];

/** The caption above a group in the list of categories; "Get started" stands alone and needs none. */
export const SETTINGS_GROUP_LABELS: Record<SettingsGroup, string | null> = { start: null, settings: "Settings", reports: "Reports" };

/**
 * The category Settings opens on: "Get started" until a session exists, which shows the setup is behind the user, and
 * from then on the folders, the settings changed most often.
 */
export function firstSettingsCategory(sessionCount: number | undefined): SettingsCategory {
  return sessionCount !== undefined && sessionCount > 0 ? "workspace" : "get-started";
}

export function settingsCategory(id: SettingsCategory): (typeof SETTINGS_CATEGORIES)[number] {
  const category = SETTINGS_CATEGORIES.find((c) => c.id === id);
  if (!category) throw new Error(`Settings have no category "${id}"`);
  return category;
}
