import type { Theme } from "vitepress";
import DefaultTheme from "vitepress/theme-without-fonts";
import CopyOrDownloadAsMarkdownButtons from "vitepress-plugin-llms/vitepress-components/CopyOrDownloadAsMarkdownButtons.vue";
import "./trackwall.css";

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    // The "Copy page" button under each title: the page as Markdown, for pasting into an AI chat.
    app.component("CopyOrDownloadAsMarkdownButtons", CopyOrDownloadAsMarkdownButtons);
  },
} satisfies Theme;
