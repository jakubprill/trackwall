import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Connection } from "../src/lib/connection.ts";
import { NewSessionPane } from "../src/views/sessions/NewSessionPane.tsx";

/** Rendering to markup sends no request, so the connection is never used. */
const conn = {} as Connection;

test("before a projects folder is set, Sessions offers no form, templates or routines, only why and Get started", () => {
  const html = renderToStaticMarkup(
    <NewSessionPane
      conn={conn}
      sessions={[]}
      projectsDir={null}
      onStarted={() => {}}
      onWorktreesRemoved={() => {}}
      onOpenGetStarted={() => {}}
    />,
  );

  expect(html).toContain("Trackwall needs your projects folder before it can start a task or session.");
  expect(html).toContain(">Get started</button>");
  expect(html).not.toContain("New task or session for the agent");
});

test("with a projects folder, Sessions shows the form for a new task or session", () => {
  const html = renderToStaticMarkup(
    <NewSessionPane
      conn={conn}
      sessions={[]}
      projectsDir="/home/you/Projects"
      onStarted={() => {}}
      onWorktreesRemoved={() => {}}
      onOpenGetStarted={() => {}}
    />,
  );

  expect(html).toContain("New task or session for the agent");
  expect(html).not.toContain("needs your projects folder");
});

test("while the workspace settings are still on their way, Sessions keeps the form rather than hide it", () => {
  const html = renderToStaticMarkup(
    <NewSessionPane
      conn={conn}
      sessions={[]}
      projectsDir={undefined}
      onStarted={() => {}}
      onWorktreesRemoved={() => {}}
      onOpenGetStarted={() => {}}
    />,
  );

  expect(html).toContain("New task or session for the agent");
  expect(html).not.toContain("needs your projects folder");
});
