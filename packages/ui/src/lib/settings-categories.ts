/**
 * The categories of Settings (ADR-102), in the order of its list. Each holds the sections that belong together, so the
 * view shows a few at a time instead of one long column, and what you set, the state you glance at and the diagnostics
 * for when something does not work stay apart. A category of reports rather than settings is `wide` (ADR-212): its
 * sections take the whole width, as their tables and lists side by side need it.
 */
export const SETTINGS_CATEGORIES = [
  {
    id: "workspace",
    label: "Workspace",
    description: "Where your repos and task worktrees live, which git reads them, and the backup of their local config.",
    sections: ["folders", "local-config-store"],
    wide: false,
  },
  {
    id: "repo-hosts",
    label: "Repo hosts",
    description: "The GitLab and GitHub hosts the Repos view searches and clones from.",
    sections: ["repo-hosts"],
    wide: false,
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
      "sandbox",
      "auto-review",
      "java-navigation",
    ],
    wide: false,
  },
  {
    id: "usage",
    label: "Usage",
    description:
      "What Copilot CLI used on this computer, how each model did on your tasks, and every call agents made to Trackwall's tools.",
    sections: ["copilot-usage", "model-stats", "mcp-calls"],
    wide: true,
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
  },
  {
    id: "files",
    label: "Files",
    description:
      "Every file and folder Trackwall reads or writes on this computer: what it is for, where it is and what is in it. Trackwall changes them only through Settings; the rest you edit by hand.",
    sections: ["config-files", "local-config-repos"],
    wide: false,
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    description: "Where to look when something does not work.",
    sections: ["doctor", "daemon", "trackwall-errors"],
    wide: false,
  },
] as const;

export type SettingsCategory = (typeof SETTINGS_CATEGORIES)[number]["id"];
export type SettingsSection = (typeof SETTINGS_CATEGORIES)[number]["sections"][number];

/** Settings opens on the folders, which a new user sets first. */
export const FIRST_SETTINGS_CATEGORY: SettingsCategory = "workspace";

export function settingsCategory(id: SettingsCategory): (typeof SETTINGS_CATEGORIES)[number] {
  const category = SETTINGS_CATEGORIES.find((c) => c.id === id);
  if (!category) throw new Error(`Settings have no category "${id}"`);
  return category;
}
