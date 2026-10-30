// The feature documentation site (ADR-56), published on GitHub Pages from .github/workflows/pages.yml.
import { TRACKWALL_DOCS_URL } from "@trackwall/protocol";
import { defineConfig } from "vitepress";
import llmstxt, { copyOrDownloadAsMarkdownButtons } from "vitepress-plugin-llms";
import { mermaidFence } from "./mermaid-fence.ts";
import { FEATURE_LIST_PAGE, SIDEBAR } from "./sidebar.ts";

const REPO_URL = "https://github.com/jakubprill/trackwall";
// GitHub Pages serves a project site under /<repo>/; `pnpm dev` uses the same path. It comes from the address agents
// get in the MCP instruction, so the two cannot drift apart.
const BASE = new URL(TRACKWALL_DOCS_URL).pathname;
// The template for feature pages is for writers, not a page of the site.
const TEMPLATE = "TEMPLATE.md";

export default defineConfig({
  title: "Trackwall",
  description: "A desktop app for working across many git repositories and many CLI coding agents at once.",
  base: BASE,
  outDir: "dist",
  srcExclude: [TEMPLATE],
  cleanUrls: true,
  // The app has one dark theme (ADR-16); the site opens dark and still offers the light one.
  appearance: "dark",
  // Dates come from git; pages.yml checks out the full history.
  lastUpdated: true,
  markdown: { config: (md) => md.use(copyOrDownloadAsMarkdownButtons).use(mermaidFence) },
  head: [["link", { rel: "icon", type: "image/svg+xml", href: `${BASE}logo.svg` }]],
  // llms.txt (an index of the pages) and llms-full.txt (every page in one file) for AI tools, plus a Markdown copy
  // of each page and a "Copy page" button under its title, so an agent reads the same text as a person
  // (except FEATURE_LIST_PAGE).
  vite: { plugins: [llmstxt({ ignoreFiles: [TEMPLATE, FEATURE_LIST_PAGE] })] },
  themeConfig: {
    logo: "/logo.svg",
    search: { provider: "local" },
    nav: [
      { text: "Guide", link: "/guide/what-is-trackwall" },
      { text: "All features", link: "/features/" },
      { text: "Releases", link: `${REPO_URL}/releases` },
    ],
    sidebar: SIDEBAR,
    socialLinks: [{ icon: "github", link: REPO_URL }],
    editLink: { pattern: `${REPO_URL}/edit/main/apps/docs/:path`, text: "Edit this page on GitHub" },
    outline: { label: "On this page" },
  },
});
