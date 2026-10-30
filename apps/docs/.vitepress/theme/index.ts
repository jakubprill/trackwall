import { type Theme, useData } from "vitepress";
import DefaultTheme from "vitepress/theme-without-fonts";
import CopyOrDownloadAsMarkdownButtons from "vitepress-plugin-llms/vitepress-components/CopyOrDownloadAsMarkdownButtons.vue";
import { defineComponent, h } from "vue";
import { MERMAID_COMPONENT } from "../mermaid-fence.ts";
import { FEATURE_LIST_PAGE } from "../sidebar.ts";
import { MermaidDiagram } from "./mermaid-diagram.ts";
import "./trackwall.css";

// The "Copy page" button under each title: the page as Markdown, for pasting into an AI chat; none on FEATURE_LIST_PAGE.
const CopyPageButton = defineComponent(() => {
  const { page } = useData();
  return () => (page.value.relativePath === FEATURE_LIST_PAGE ? null : h(CopyOrDownloadAsMarkdownButtons));
});

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("CopyOrDownloadAsMarkdownButtons", CopyPageButton);
    app.component(MERMAID_COMPONENT, MermaidDiagram);
  },
} satisfies Theme;
