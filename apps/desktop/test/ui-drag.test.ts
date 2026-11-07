import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "../scripts/lib.ts";

// The desktop shell takes every native drag over its window for dropping files (ADR-51): WKWebView never passes it to
// the page and WebView2 loses its own drop target, so HTML5 drag and drop works in a browser and does nothing in the
// app. Something the user drags inside the page is moved with pointer events, like a card of the board (ADR-217).
test("the UI uses no HTML5 drag and drop, which the desktop window never delivers to the page", () => {
  const dir = join(REPO, "packages/ui/src");
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" }).filter((f) => /\.(ts|tsx)$/.test(f));
  const drags = files.filter((f) =>
    /\bdraggable\b|\bdataTransfer\b|\bonDrag(?:Start|Over|Enter|Leave|End)?\b/.test(readFileSync(join(dir, f), "utf8")),
  );
  expect(files.length).toBeGreaterThan(0);
  expect(drags).toEqual([]);
});
