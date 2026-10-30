// Turns a ```mermaid code block into the MermaidDiagram component of the theme, which draws it in the browser.
// The page's Markdown copy and llms.txt keep the block as it is, so an agent reads the diagram's source.
import type { MarkdownRenderer } from "vitepress";

/** The component the theme registers for diagrams (`theme/mermaid-diagram.ts`). */
export const MERMAID_COMPONENT = "MermaidDiagram";

export function mermaidFence(md: MarkdownRenderer): void {
  const fence = md.renderer.rules.fence;
  if (fence === undefined) throw new Error("markdown-it has no fence renderer to extend");
  md.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index];
    if (token?.info.trim() !== "mermaid") return fence(tokens, index, options, env, self);
    // Encoded, so the diagram's braces and quotes cannot reach Vue's template syntax or end the attribute.
    return `<${MERMAID_COMPONENT} code="${encodeURIComponent(token.content)}" />\n`;
  };
}
