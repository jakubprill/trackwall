/**
 * The categories of Settings (ADR-102), in the order of its list. Each holds the sections that belong together, so the
 * view shows a few at a time instead of one long column, and what you set, the state you glance at and the diagnostics
 * for when something does not work stay apart.
 */
export const SETTINGS_CATEGORIES = [
  {
    id: "workspace",
    label: "Workspace",
    description: "Where your repos and task worktrees live, which git reads them, and the backup of their local config.",
    sections: ["folders", "local-config-store"],
  },
  {
    id: "repo-hosts",
    label: "Repo hosts",
    description: "The GitLab and GitHub hosts the Repos view searches and clones from.",
    sections: ["repo-hosts"],
  },
  {
    id: "agents",
    label: "Agents",
    description: "What Copilot CLI gets from Trackwall.",
    sections: ["copilot-cli"],
  },
  {
    id: "app",
    label: "App",
    description: "The desktop app on this computer.",
    sections: ["start-at-sign-in", "updates", "home-scene"],
  },
  {
    id: "files",
    label: "Files",
    description:
      "Every file and folder Trackwall reads or writes on this computer: what it is for, where it is and what is in it. Trackwall changes them only through Settings; the rest you edit by hand.",
    sections: ["config-files", "local-config-repos"],
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    description: "Where to look when something does not work.",
    sections: ["doctor", "daemon", "trackwall-errors"],
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
