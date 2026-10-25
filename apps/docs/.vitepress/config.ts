// The feature documentation site (ADR-56), published on GitHub Pages from .github/workflows/pages.yml.
import { defineConfig } from "vitepress";

const REPO_URL = "https://github.com/jakubprill/trackwall";
// GitHub Pages serves a project site under /<repo>/; `pnpm dev` uses the same path.
const BASE = "/trackwall/";

export default defineConfig({
  title: "Trackwall",
  description: "A desktop app for working across many git repositories and many CLI coding agents at once.",
  base: BASE,
  outDir: "dist",
  cleanUrls: true,
  // The app has one dark theme (ADR-16); the site opens dark and still offers the light one.
  appearance: "dark",
  // Dates come from git; pages.yml checks out the full history.
  lastUpdated: true,
  head: [["link", { rel: "icon", type: "image/svg+xml", href: `${BASE}logo.svg` }]],
  themeConfig: {
    logo: "/logo.svg",
    search: { provider: "local" },
    nav: [
      { text: "Guide", link: "/guide/what-is-trackwall" },
      { text: "Features", link: "/features/home" },
      { text: "MCP tools", link: "/features/mcp" },
      { text: "Releases", link: `${REPO_URL}/releases` },
    ],
    sidebar: [
      {
        text: "Start",
        items: [
          { text: "What is Trackwall", link: "/guide/what-is-trackwall" },
          { text: "Install", link: "/guide/install" },
          { text: "Connect Copilot CLI", link: "/guide/connect-copilot-cli" },
        ],
      },
      {
        text: "Views",
        items: [
          { text: "Home dashboard", link: "/features/home" },
          { text: "Repos", link: "/features/repos" },
          { text: "mise tasks", link: "/features/mise-tasks" },
          { text: "Services", link: "/features/services" },
          { text: "Repo card and tags", link: "/features/repo-card" },
          { text: "Connection graph", link: "/features/graph" },
          { text: "Batch command", link: "/features/batch-command" },
          { text: "Copilot CLI sessions", link: "/features/sessions" },
          { text: "Agent tasks", link: "/features/tasks" },
          { text: "Main session and task proposals", link: "/features/main-session" },
        ],
      },
      {
        text: "Everywhere",
        items: [
          { text: "Navigation and windows", link: "/features/navigation-and-windows" },
          { text: "trackwall:// links", link: "/features/links" },
          { text: "MCP server", link: "/features/mcp" },
        ],
      },
    ],
    socialLinks: [{ icon: "github", link: REPO_URL }],
    editLink: { pattern: `${REPO_URL}/edit/main/apps/docs/:path`, text: "Edit this page on GitHub" },
    outline: { label: "On this page" },
  },
});
