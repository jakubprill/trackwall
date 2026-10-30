import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import DOMPurify from "dompurify";
import mermaid from "mermaid";

// The site draws a diagram only in the reader's browser, where a syntax error would quietly leave its source on the
// page; so every diagram of the site is parsed here.
// Parsing a diagram's labels goes through DOMPurify, which needs a browser's DOM and has none of its functions under
// Bun. Labels are not drawn here, so a pass-through stands in. It is the copy Mermaid imports only while both name
// the same DOMPurify version; with another, parsing fails loudly and this pin follows Mermaid's.
Object.assign(DOMPurify, { addHook: () => {}, removeHook: () => {}, removeHooks: () => {}, sanitize: (text: string) => text });

const DOCS = join(import.meta.dir, "..");
const pages = ["guide", "features"].flatMap((dir) =>
  readdirSync(join(DOCS, dir))
    .filter((file) => file.endsWith(".md"))
    .map((file) => `${dir}/${file}`),
);
const diagrams = pages.flatMap((page) =>
  [...readFileSync(join(DOCS, page), "utf8").matchAll(/^```mermaid\n([\s\S]*?)^```$/gm)].map((match, index) => ({
    diagram: `${page} #${index + 1}`,
    source: match[1] ?? "",
  })),
);

test("the site has diagrams to check", () => {
  expect(diagrams.length).toBeGreaterThan(0);
});

test("every diagram on the site parses", async () => {
  for (const { diagram, source } of diagrams) {
    const parsed = await mermaid.parse(source, { suppressErrors: true });
    expect({ diagram, parses: parsed !== false }).toEqual({ diagram, parses: true });
  }
});
