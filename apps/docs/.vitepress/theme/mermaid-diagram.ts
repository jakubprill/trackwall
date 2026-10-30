// Draws one Mermaid diagram in the browser, again when the reader switches between the dark and the light theme.
// Until Mermaid loads (and in the server-rendered page) the diagram's source shows as a code block.
import { useData } from "vitepress";
import { defineComponent, h, onMounted, ref, watch } from "vue";

let nextId = 0;

export const MermaidDiagram = defineComponent({
  props: { code: { type: String, required: true } },
  setup(props) {
    const { isDark } = useData();
    const source = decodeURIComponent(props.code);
    const svg = ref("");
    const id = `mermaid-${nextId++}`;

    async function draw(): Promise<void> {
      const { default: mermaid } = await import("mermaid");
      // Mermaid sizes every box by measuring its text, so it measures in the page's own font, once that has loaded.
      await document.fonts.ready;
      mermaid.initialize({
        startOnLoad: false,
        // "strict" keeps the diagram's text from running scripts or links; the diagrams are ours, but the rule is cheap.
        securityLevel: "strict",
        theme: isDark.value ? "dark" : "neutral",
        themeVariables: { fontFamily: getComputedStyle(document.body).fontFamily },
      });
      svg.value = (await mermaid.render(id, source)).svg;
    }

    onMounted(() => void draw());
    watch(isDark, () => void draw());
    return () =>
      svg.value === ""
        ? h("pre", { class: "mermaid-source" }, h("code", source))
        : h("div", { class: "mermaid-diagram", innerHTML: svg.value });
  },
});
