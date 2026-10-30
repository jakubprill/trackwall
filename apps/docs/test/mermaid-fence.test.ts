import { expect, test } from "bun:test";
import { createMarkdownRenderer } from "vitepress";
import { MERMAID_COMPONENT, mermaidFence } from "../.vitepress/mermaid-fence.ts";

const markdown = await createMarkdownRenderer(import.meta.dir);
markdown.use(mermaidFence);

test("a mermaid code block becomes the diagram component with its source encoded", () => {
  const html = markdown.render('```mermaid\nflowchart LR\n  a["{{ x }}"] --> b\n```\n');
  expect(html).toBe(`<${MERMAID_COMPONENT} code="flowchart%20LR%0A%20%20a%5B%22%7B%7B%20x%20%7D%7D%22%5D%20--%3E%20b%0A" />\n`);
});

test("another code block keeps its highlighted code", () => {
  const html = markdown.render("```yaml\nkey: value\n```\n");
  expect({ component: html.includes(MERMAID_COMPONENT), code: html.includes("language-yaml") }).toEqual({ component: false, code: true });
});
