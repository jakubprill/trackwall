import { type Theme, useData } from "vitepress";
import DefaultTheme from "vitepress/theme-without-fonts";
import CopyOrDownloadAsMarkdownButtons from "vitepress-plugin-llms/vitepress-components/CopyOrDownloadAsMarkdownButtons.vue";
import { defineComponent, h } from "vue";
import { MERMAID_COMPONENT } from "../mermaid-fence.ts";
import { FEATURE_LIST_PAGE } from "../sidebar.ts";
import { TALK_PAGES } from "../talk-pages.ts";
import { useImageZoom } from "./image-zoom.ts";
import { MermaidDiagram } from "./mermaid-diagram.ts";
import { useTalkKeys } from "./talk-keys.ts";
import "./trackwall.css";

/** The pages the build writes no Markdown copy of (config.ts), so they get no button to copy one. */
const PAGES_WITHOUT_COPY = [FEATURE_LIST_PAGE, ...TALK_PAGES];

// The "Copy page" button under each title: the page as Markdown, for pasting into an AI chat.
const CopyPageButton = defineComponent(() => {
  const { page } = useData();
  return () => (PAGES_WITHOUT_COPY.includes(page.value.relativePath) ? null : h(CopyOrDownloadAsMarkdownButtons));
});

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("CopyOrDownloadAsMarkdownButtons", CopyPageButton);
    app.component(MERMAID_COMPONENT, MermaidDiagram);
  },
  setup() {
    useImageZoom();
    useTalkKeys();
  },
} satisfies Theme;
