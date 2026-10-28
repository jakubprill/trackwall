import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_ENTRIES, WORKSPACE_KEYS } from "@trackwall/protocol";
import { FEATURE_GROUPS } from "../.vitepress/sidebar.ts";

// Every feature page follows TEMPLATE.md, so "All features", the sidebar and llms.txt stay complete (ADR-56).
const DOCS = join(import.meta.dir, "..");
const featurePages = readdirSync(join(DOCS, "features")).filter((file) => file.endsWith(".md") && file !== "index.md");
const guidePages = readdirSync(join(DOCS, "guide")).filter((file) => file.endsWith(".md"));
const sitePages = ["index.md", "features/index.md", ...featurePages.map((f) => `features/${f}`), ...guidePages.map((f) => `guide/${f}`)];
const read = (path: string) => readFileSync(join(DOCS, path), "utf8");
/** A field of a parsed YAML or JSON value, or undefined when the value is not an object. */
const field = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined);
/** The file of a feature page from its link, `/features/repos` → `repos.md`. */
const pageFile = (link: string) => `${link.replace(/^\/features\//, "")}.md`;
/** The sections a feature page may have between "Use it" and "Good to know" (TEMPLATE.md). */
const REFERENCE_SECTIONS = ["Shortcuts", "Tools"];

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
    const between = headings.slice(3, -1).filter((heading) => !REFERENCE_SECTIONS.includes(heading));
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
  const inSidebar = FEATURE_GROUPS.flatMap((group) => group.items.map((item) => pageFile(item.link))).sort();
  expect(inSidebar).toEqual([...featurePages].sort());
});

test("a sidebar entry has the title of its page", () => {
  for (const item of FEATURE_GROUPS.flatMap((group) => group.items)) {
    const file = pageFile(item.link);
    expect({ file, title: featurePage(file).title }).toEqual({ file, title: item.text });
  }
});

test("a feature card on the home page shows the description of its page", () => {
  const { features } = frontmatter("index.md").fields;
  if (!Array.isArray(features)) throw new Error("index.md has no feature cards");
  const cards: unknown[] = features;
  expect(cards.length).toBeGreaterThan(0);
  for (const card of cards) {
    const link = field(card, "link");
    const details = field(card, "details");
    if (typeof link !== "string") throw new Error("a feature card on the home page has no link");
    const file = pageFile(link);
    expect({ file, details }).toEqual({ file, details: featurePage(file).description });
  }
});

test("no page of the site points at decision records or the developer documents", () => {
  const pointing = sitePages.filter((path) => /ADR-\d+|§\d|\/blob\/main\/docs\//.test(read(path)));
  expect(pointing).toEqual([]);
});

test("every screenshot a page shows is in public/screenshots", () => {
  const missing = sitePages.flatMap((path) =>
    [...read(path).matchAll(/\]\((\/screenshots\/[^)]+)\)/g)]
      .map((m) => m[1] ?? "")
      .filter((image) => !existsSync(join(DOCS, "public", image))),
  );
  expect(missing).toEqual([]);
});

test("the install commands download the current version", () => {
  const daemon: unknown = JSON.parse(readFileSync(join(DOCS, "../../packages/daemon/package.json"), "utf8"));
  const version = field(daemon, "version");
  if (typeof version !== "string") throw new Error("packages/daemon/package.json has no version");
  const install = read("guide/install.md");
  const versions = [...install.matchAll(/\$v = "([^"]+)"|trackwall-(\d[^-]*)-macos/g)].map((m) => m[1] ?? m[2]);
  expect(versions).toEqual([version, version]);
});

test("every page Settings › Files links to for a file or a key of workspace.yaml is a feature page", () => {
  const pages = [...Object.values(CONFIG_ENTRIES), ...Object.values(WORKSPACE_KEYS)].map((info) => `${info.docs}.md`);
  expect(pages.filter((page) => !featurePages.includes(page))).toEqual([]);
});
