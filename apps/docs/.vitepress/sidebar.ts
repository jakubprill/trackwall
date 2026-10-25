// The sidebar, and with it the groups and order of "All features" (features/features.data.ts): one list of pages.
import type { DefaultTheme } from "vitepress";

/**
 * "All features", drawn by Vue from the groups below, so its Markdown source holds no list: it gets no Markdown
 * copy and no "Copy page" button, and llms.txt lists the features with their descriptions anyway.
 */
export const FEATURE_LIST_PAGE = "features/index.md";

/** A group of feature pages; its title is the heading in the sidebar and in "All features". */
export interface FeatureGroup {
  text: string;
  items: { text: string; link: string }[];
}

export const FEATURE_GROUPS: FeatureGroup[] = [
  {
    text: "Repos",
    items: [
      { text: "Repos", link: "/features/repos" },
      { text: "Repo card and tags", link: "/features/repo-card" },
      { text: "Connection graph", link: "/features/graph" },
    ],
  },
  {
    text: "Run",
    items: [
      { text: "mise tasks", link: "/features/mise-tasks" },
      { text: "Services", link: "/features/services" },
      { text: "Batch command", link: "/features/batch-command" },
    ],
  },
  {
    text: "Agents",
    items: [
      { text: "Supervisor", link: "/features/supervisor" },
      { text: "Copilot CLI sessions", link: "/features/sessions" },
      { text: "Agent tasks", link: "/features/tasks" },
      { text: "Main session and task proposals", link: "/features/main-session" },
      { text: "Session instructions", link: "/features/session-instructions" },
      { text: "MCP server", link: "/features/mcp" },
    ],
  },
  {
    text: "Desktop",
    items: [
      { text: "Home dashboard", link: "/features/home" },
      { text: "Navigation and windows", link: "/features/navigation-and-windows" },
      { text: "trackwall:// links", link: "/features/links" },
    ],
  },
];

export const SIDEBAR: DefaultTheme.SidebarItem[] = [
  {
    text: "Start",
    items: [
      { text: "What is Trackwall", link: "/guide/what-is-trackwall" },
      { text: "Install", link: "/guide/install" },
      { text: "Connect Copilot CLI", link: "/guide/connect-copilot-cli" },
    ],
  },
  { text: "All features", link: "/features/" },
  ...FEATURE_GROUPS,
];
