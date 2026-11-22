import { expect, test } from "bun:test";
import type { RoutineEntry } from "@trackwall/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import type { Connection } from "../src/lib/connection.ts";
import { RoutineSection } from "../src/views/sessions/RoutineList.tsx";

/** Rendering to markup sends no request, so the connection is never used. */
const conn = {} as Connection;

const proposed: RoutineEntry = {
  name: "update-orders-client",
  title: "Update the orders API client",
  repo: "shop-web",
  model: null,
  approvals: "ask",
  prompt: "Regenerate the orders API client from the spec and check that it compiles.",
  digest: "a".repeat(64),
  approved: false,
};

function section(routines: RoutineEntry[], problems: { file: string; message: string }[]): string {
  return renderToStaticMarkup(
    <RoutineSection conn={conn} routines={routines} problems={problems} onChanged={() => {}} onStarted={() => {}} />,
  );
}

test("without routines and without files that failed to read, the form has no Routines section", () => {
  expect(section([], [])).toBe("");
});

test("the first routine an agent proposes brings the section, with the routine waiting for approval", () => {
  const html = section([proposed], []);

  expect(html).toContain(">Routines</h3>");
  expect(html).toContain("Update the orders API client");
  expect(html).toContain("needs your approval");
});

test("a file of the routines folder that could not be read shows the section with why, also without a routine", () => {
  const html = section([], [{ file: "broken.md", message: "the frontmatter names no repo" }]);

  expect(html).toContain(">Routines</h3>");
  expect(html).toContain("broken.md");
  expect(html).toContain("the frontmatter names no repo");
});
