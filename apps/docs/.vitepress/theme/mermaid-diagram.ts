// Draws one Mermaid diagram in the browser, again when the reader switches between the dark and the light theme.
// Until Mermaid loads (and in the server-rendered page) the diagram's source shows as a code block.
import { useData } from "vitepress";
import { defineComponent, h, onMounted, ref, useId, watch } from "vue";

export const MermaidDiagram = defineComponent({
  props: { code: { type: String, required: true } },
  setup(props) {
    const { isDark } = useData();
    const source = decodeURIComponent(props.code);
    const svg = ref("");
    // Mermaid needs an element id that is unique on the page and a valid CSS identifier.
    const id = `mermaid-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;
    // A theme switch while a draw is still running starts another; only the newest may show its result.
    let latestDraw = 0;

    async function draw(): Promise<void> {
      const thisDraw = ++latestDraw;
      const { default: mermaid } = await import("mermaid");
      // Mermaid sizes every box by measuring its text, so it measures in the page's own font, once that has loaded.
      await document.fonts.ready;
      // Mermaid keeps its settings globally; every diagram on the page sets the same ones for the current theme.
      mermaid.initialize({
        startOnLoad: false,
        // "strict" keeps the diagram's text from running scripts or links; the diagrams are ours, but the rule is cheap.
        securityLevel: "strict",
        theme: isDark.value ? "dark" : "neutral",
        themeVariables: { fontFamily: getComputedStyle(document.body).fontFamily },
      });
      const { svg: drawn } = await mermaid.render(id, source);
      if (thisDraw === latestDraw) svg.value = drawn;
    }

    // A diagram that does not parse keeps showing its source; test/diagrams.test.ts keeps that from reaching the site.
    const drawOrReport = () => draw().catch((error: unknown) => console.error(`Mermaid could not draw ${id}`, error));
    onMounted(drawOrReport);
    watch(isDark, drawOrReport);
    return () =>
      svg.value === ""
        ? h("pre", { class: "mermaid-source" }, h("code", source))
        : h("div", { class: "mermaid-diagram", innerHTML: svg.value });
  },
});
