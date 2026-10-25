import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FEATURE_GROUPS } from "../.vitepress/sidebar.ts";

// Every feature page follows TEMPLATE.md, so "All features", the sidebar and llms.txt stay complete (ADR-56).
const DOCS = join(import.meta.dir, "..");
const FEATURES = join(DOCS, "features");
const featurePages = readdirSync(FEATURES).filter((file) => file.endsWith(".md") && file !== "index.md");
const read = (file: string) => readFileSync(join(FEATURES, file), "utf8");

/** The `title` and `description` of a page's frontmatter, with optional quotes removed. */
function frontmatter(markdown: string): Record<string, string> {
  const block = markdown.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
  if (block === undefined) throw new Error("no frontmatter");
  const fields = block.split("\n").map((line) => line.match(/^(\w+):\s*"?(.*?)"?$/));
  return Object.fromEntries(fields.flatMap((m) => (m?.[1] && m[2] !== undefined ? [[m[1], m[2]]] : [])));
}

const headings = (markdown: string, level: string) => [...markdown.matchAll(new RegExp(`^${level} (.+)$`, "gm"))].map((m) => m[1]);

test("every feature page has a title and a one-sentence description of at most 160 characters", () => {
  for (const file of featurePages) {
    const { title = "", description = "" } = frontmatter(read(file));
    expect({ file, hasTitle: title.length > 0, descriptionFits: description.length > 0 && description.length <= 160 }).toEqual({
      file,
      hasTitle: true,
      descriptionFits: true,
    });
  }
});

test("a feature page opens with its title and repeats its description as the lede", () => {
  for (const file of featurePages) {
    const markdown = read(file);
    const { title, description } = frontmatter(markdown);
    const body = markdown.replace(/^---\n[\s\S]*?\n---\n\s*/, "");
    const [heading, , lede] = body.split("\n");
    expect({ file, heading, lede }).toEqual({ file, heading: `# ${title}`, lede: description });
  }
});

test("a feature page has the sections of the template in its order", () => {
  for (const file of featurePages) {
    const sections = headings(read(file), "##");
    expect({ file, start: sections.slice(0, 3), end: sections.at(-1) }).toEqual({
      file,
      start: ["What you get", "How it works", "Use it"],
      end: "Good to know",
    });
  }
});

test("every feature page is in the sidebar, and every sidebar entry has a page", () => {
  const inSidebar = FEATURE_GROUPS.flatMap((group) => group.items.map((item) => item.link)).sort();
  const pages = featurePages.map((file) => `/features/${file.replace(/\.md$/, "")}`).sort();
  expect(inSidebar).toEqual(pages);
});

test("no page of the site points at decision records", () => {
  const pages = [
    ...featurePages.map((file) => join(FEATURES, file)),
    ...readdirSync(join(DOCS, "guide")).map((f) => join(DOCS, "guide", f)),
  ];
  const withAdr = pages.filter((path) => /ADR-\d+/.test(readFileSync(path, "utf8")));
  expect(withAdr).toEqual([]);
});
