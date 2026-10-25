import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TRACKWALL_DOCS_LLMS_URL, TRACKWALL_DOCS_URL } from "../src/docs-site.ts";

test("the documentation address agents get is where the site is published, with llms.txt at its root", () => {
  const config = readFileSync(join(import.meta.dir, "../../../apps/docs/.vitepress/config.ts"), "utf8");
  expect(config).toContain(`const BASE = "${new URL(TRACKWALL_DOCS_URL).pathname}";`);
  expect(config).toContain("llmstxt(");
  expect(TRACKWALL_DOCS_LLMS_URL).toBe("https://jakubprill.github.io/trackwall/llms.txt");
});
