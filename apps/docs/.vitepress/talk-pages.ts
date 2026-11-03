// The talk: a ten-minute walk through Trackwall as slides that scroll, for a presenter and for anyone who missed it
// (ADR-56). The site does not link it from its navigation, search engines are asked not to index it, and it has
// no Markdown copy, since it repeats the guide for listeners rather than readers.

/** The English talk and its Polish translation (ADR-142), as VitePress names the source files. */
export const TALK_PAGES = ["talk.md", "pl/talk.md"];

/** The `pageClass` of a talk page: its slides snap into place and the arrow keys move between them (trackwall.css). */
export const TALK_PAGE_CLASS = "talk";

/**
 * What config.ts sets on every talk page, so the two languages cannot differ: the whole width for the slides, no
 * page links around them, and no indexing. The site search reads a page's own frontmatter, so `search: false`
 * stays in each file.
 */
export const TALK_FRONTMATTER = {
  pageClass: TALK_PAGE_CLASS,
  sidebar: false,
  aside: false,
  outline: false,
  editLink: false,
  lastUpdated: false,
  prev: false,
  next: false,
  head: [["meta", { name: "robots", content: "noindex" }]],
};
