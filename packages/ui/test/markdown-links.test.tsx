import { expect, test } from "bun:test";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import rehypeSanitize from "rehype-sanitize";
import { Streamdown } from "streamdown";
import { MARKDOWN_REMARK_PLUGINS, MARKDOWN_SANITIZE_SCHEMA, markdownLinkAddress } from "../src/lib/markdown-links.ts";

const SESSION = "0b7e3a52-5c1f-4c55-9a4e-2f1d7c3b9e10";

/** Only the address and the text, so the test reads them; the real component is `Link` in `components/Markdown.tsx`. */
const components = { a: ({ href, children }: ComponentProps<"a">) => <a href={href}>{children}</a> };

/** The links an agent's answer ends up with, as `href` and text, through the same plugins as the conversation view. */
function linksIn(markdown: string): string[] {
  const html = renderToStaticMarkup(
    <Streamdown
      mode="static"
      remarkPlugins={MARKDOWN_REMARK_PLUGINS}
      rehypePlugins={[[rehypeSanitize, MARKDOWN_SANITIZE_SCHEMA]]}
      components={components}
    >
      {markdown}
    </Streamdown>,
  );
  return [...html.matchAll(/<a(?: href="([^"]*)")?>(.*?)<\/a>/g)].map(
    ([, href = "", text = ""]) => `${href} ${text.replace(/<[^>]+>/g, "")}`,
  );
}

test("a Markdown link to a repo keeps its trackwall address", () => {
  expect(linksIn("Look at [orders-api](trackwall://repo/orders-api).")).toEqual(["trackwall://repo/orders-api orders-api"]);
});

test("a bare trackwall link in text becomes a link, without the full stop after it", () => {
  expect(linksIn(`The task runs in trackwall://session/${SESSION}. Check it.`)).toEqual([
    `trackwall://session/${SESSION} trackwall://session/${SESSION}`,
  ]);
});

test("inline code that holds only a trackwall link becomes a link around the code", () => {
  expect(linksIn("Open `trackwall://repo/orders-api` now, but not `see trackwall://repo/orders-api`.")).toEqual([
    "trackwall://repo/orders-api trackwall://repo/orders-api",
  ]);
});

test("a trackwall link in a code block stays code", () => {
  expect(linksIn("```\ntrackwall://repo/orders-api\n```")).toEqual([]);
});

test("text that only looks like a trackwall link stays text", () => {
  expect(linksIn("trackwall://repo/Orders, trackwall://service/orders-api and trackwall://session/1234")).toEqual([]);
});

test("web links still work and other protocols lose their address", () => {
  expect(linksIn("[docs](https://example.com/docs) [x](javascript:alert(1)) [f](file:///etc/passwd)")).toEqual([
    "https://example.com/docs docs",
    " x",
    " f",
  ]);
});

test("a trackwall link with an upper-case scheme still links, with the address written in lower case", () => {
  expect(linksIn("See TrackWall://repo/orders-api now")).toEqual(["trackwall://repo/orders-api TrackWall://repo/orders-api"]);
});

test("a longer address that starts like a trackwall link stays text", () => {
  expect(linksIn("see trackwall://repo/orders/main and trackwall://repo/orders?run=1")).toEqual([]);
});

test("a Markdown link keeps a trackwall or web address and drops any other", () => {
  expect(markdownLinkAddress("trackwall://repo/orders-api")).toBe("trackwall://repo/orders-api");
  expect(markdownLinkAddress("https://example.com/docs")).toBe("https://example.com/docs");
  expect(markdownLinkAddress("trackwall://repo/orders-api?run=1")).toBeUndefined();
  expect(markdownLinkAddress("javascript:alert(1)")).toBeUndefined();
  expect(markdownLinkAddress("#top")).toBeUndefined();
  expect(markdownLinkAddress(undefined)).toBeUndefined();
});
