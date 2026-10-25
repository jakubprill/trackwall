// The feature documentation site (ADR-56), published on GitHub Pages from .github/workflows/pages.yml.
import { defineConfig, type MarkdownEnv, type MarkdownOptions } from "vitepress";
import llmstxt, { copyOrDownloadAsMarkdownButtons } from "vitepress-plugin-llms";
import { SIDEBAR } from "./sidebar.ts";

const REPO_URL = "https://github.com/jakubprill/trackwall";
// GitHub Pages serves a project site under /<repo>/; `pnpm dev` uses the same path.
const BASE = "/trackwall/";
// The template for feature pages is for writers, not a page of the site.
const TEMPLATE = "TEMPLATE.md";
// "All features" is built by Vue from the sidebar, so its Markdown source holds no list; llms.txt lists the
// features with their descriptions anyway.
const FEATURE_LIST = "features/index.md";

/** The "Copy page" button under the title of every page whose Markdown source is what the reader sees. */
const copyPageButton: NonNullable<MarkdownOptions["config"]> = (md) => {
  const render = md.renderer.render.bind(md.renderer);
  md.use(copyOrDownloadAsMarkdownButtons);
  const renderWithButton = md.renderer.render.bind(md.renderer);
  md.renderer.render = (tokens, options, env: MarkdownEnv) =>
    (env.relativePath === FEATURE_LIST ? render : renderWithButton)(tokens, options, env);
};

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
  markdown: { config: copyPageButton },
  head: [["link", { rel: "icon", type: "image/svg+xml", href: `${BASE}logo.svg` }]],
  // llms.txt (an index of the pages) and llms-full.txt (every page in one file) for AI tools, plus a Markdown copy
  // of each page and a "Copy page" button under its title, so an agent reads the same text as a person.
  vite: { plugins: [llmstxt({ ignoreFiles: [TEMPLATE, FEATURE_LIST] })] },
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
