/**
 * The tabs of one repo in the "Repos" view, in the order they show; a repo opens on the first. The card comes first,
 * because it sums the repo up (tags, apps, endpoints, what is missing); the README is last, because it is the repo's
 * own prose and rarely the reason to open a repo in Trackwall.
 */
export const REPO_TABS = [
  { id: "card", label: "Card" },
  { id: "files", label: "Files" },
  { id: "commits", label: "Commits" },
  { id: "changes", label: "Changes" },
  { id: "mise", label: "mise tasks" },
  { id: "readme", label: "README" },
] as const;

export type RepoTab = (typeof REPO_TABS)[number]["id"];
