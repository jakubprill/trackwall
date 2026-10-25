import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FEATURE_GROUPS } from "../.vitepress/sidebar.ts";

// Every feature page follows TEMPLATE.md, so "All features", the sidebar and llms.txt stay complete (ADR-56).
const DOCS = join(import.meta.dir, "..");
const featurePages = readdirSync(join(DOCS, "features")).filter((file) => file.endsWith(".md") && file !== "index.md");
const guidePages = readdirSync(join(DOCS, "guide")).filter((file) => file.endsWith(".md"));
const sitePages = ["index.md", "features/index.md", ...featurePages.map((f) => `features/${f}`), ...guidePages.map((f) => `guide/${f}`)];
const read = (path: string) => readFileSync(join(DOCS, path), "utf8");

/** A page's frontmatter, read as YAML as VitePress reads it, and the Markdown after it. */
function frontmatter(path: string): { fields: Record<string, unknown>; body: string } {
  const markdown = read(path);
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n\s*/);
  if (match?.[1] === undefined) throw new Error(`${path} has no frontmatter`);
  const fields: unknown = Bun.YAML.parse(match[1]);
  if (typeof fields !== "object" || fields === null) throw new Error(`${path} has no frontmatter fields`);
  return { fields: Object.fromEntries(Object.entries(fields)), body: markdown.slice(match[0].length) };
}

/** The title, description and Markdown of a feature page; a title or description that is not text is an error. */
function featurePage(file: string): { title: string; description: string; body: string } {
  const { fields, body } = frontmatter(`features/${file}`);
  const { title, description } = fields;
  if (typeof title !== "string" || typeof description !== "string") throw new Error(`${file} needs a text title and description`);
  return { title, description, body };
}

/** The `## ` sections of a page, outside code blocks, each with its text up to the next section. */
function sections(body: string): { heading: string; text: string }[] {
  const parts = body
    .replace(/^```[\s\S]*?^```/gm, "")
    .split(/^## /m)
    .slice(1);
  return parts.map((part) => ({ heading: part.slice(0, part.indexOf("\n")), text: part.slice(part.indexOf("\n") + 1) }));
}

test("every feature page has a title and a one-sentence description of at most 160 characters", () => {
  for (const file of featurePages) {
    const { title, description } = featurePage(file);
    const oneSentence = /^[^.!?]+[.!?]$/.test(description) && description.length <= 160;
    expect({ file, hasTitle: title.length > 0, oneSentence }).toEqual({ file, hasTitle: true, oneSentence: true });
  }
});

test("a feature page opens with its title and repeats its description as the lede", () => {
  for (const file of featurePages) {
    const { title, description, body } = featurePage(file);
    const [heading, , lede] = body.split("\n");
    expect({ file, heading, lede }).toEqual({ file, heading: `# ${title}`, lede: description });
  }
});

test("a feature page has the sections of the template in its order, with only reference tables in between", () => {
  for (const file of featurePages) {
    const headings = sections(featurePage(file).body).map((section) => section.heading);
    const between = headings.slice(3, -1).filter((heading) => !["Shortcuts", "Tools"].includes(heading));
    expect({ file, start: headings.slice(0, 3), between, end: headings.at(-1) }).toEqual({
      file,
      start: ["What you get", "How it works", "Use it"],
      between: [],
      end: "Good to know",
    });
  }
});

test("'What you get' lists three to five things", () => {
  for (const file of featurePages) {
    const whatYouGet = sections(featurePage(file).body).find((section) => section.heading === "What you get");
    const bullets = whatYouGet?.text.match(/^- /gm)?.length ?? 0;
    expect({ file, fits: bullets >= 3 && bullets <= 5 }).toEqual({ file, fits: true });
  }
});

test("every feature page is in the sidebar, and every sidebar entry has a page", () => {
  const inSidebar = FEATURE_GROUPS.flatMap((group) => group.items.map((item) => item.link)).sort();
  const pages = featurePages.map((file) => `/features/${file.replace(/\.md$/, "")}`).sort();
  expect(inSidebar).toEqual(pages);
});

test("a sidebar entry has the title of its page", () => {
  for (const item of FEATURE_GROUPS.flatMap((group) => group.items)) {
    const file = `${item.link.replace("/features/", "")}.md`;
    expect({ file, title: featurePage(file).title }).toEqual({ file, title: item.text });
  }
});

test("a feature card on the home page shows the description of its page", () => {
  const { features } = frontmatter("index.md").fields;
  if (!Array.isArray(features)) throw new Error("index.md has no feature cards");
  expect(features.length).toBeGreaterThan(0);
  for (const card of features) {
    const file = `${String(card.link).replace("/features/", "")}.md`;
    expect({ file, details: card.details }).toEqual({ file, details: featurePage(file).description });
  }
});

test("no page of the site points at decision records or the developer documents", () => {
  const pointing = sitePages.filter((path) => /ADR-\d+|§\d|\/blob\/main\/docs\//.test(read(path)));
  expect(pointing).toEqual([]);
});
