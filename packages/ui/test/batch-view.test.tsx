import { expect, test } from "bun:test";
import type { Repo } from "@trackwall/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import type { BatchRunHandle } from "../src/lib/use-batch-run.ts";
import { BatchView } from "../src/views/repos/BatchView.tsx";

const repos: Repo[] = ["orders-api", "shop-web"].map((id) => ({ id, path: `/projects/${id}`, remote: null, status: { kind: "loading" } }));
const batch: BatchRunHandle = { run: null, running: false, error: undefined, start: () => {}, cancel: () => {} };

test("the batch command opens with no step and no repo ticked, All and None over both lists, and Run off", () => {
  const html = renderToStaticMarkup(<BatchView batch={batch} repos={repos} />);

  expect(html.match(/type="checkbox"/g)).toHaveLength(4 + repos.length);
  expect(html).not.toContain(`checked=""`);
  expect(html.match(/>All</g)).toHaveLength(2);
  expect(html.match(/>None</g)).toHaveLength(2);
  expect(html).toContain(">0/4<");
  expect(html).toContain(">0/2<");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?Run on 0 repos<\/button>/);
  expect(html).toContain("Choose at least one step and one repo.");
});
