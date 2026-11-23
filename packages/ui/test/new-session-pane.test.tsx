import { expect, test } from "bun:test";
import type { WorkspaceSettings } from "@trackwall/protocol";
import { renderToStaticMarkup } from "react-dom/server";
import type { Connection } from "../src/lib/connection.ts";
import type { RemoteHandle } from "../src/lib/use-remote.ts";
import { NewSessionPane } from "../src/views/sessions/NewSessionPane.tsx";

/** Rendering to markup sends no request, so the connection is never used. */
const conn = {} as Connection;

/** The window's read of the workspace settings with only the projects folder, `undefined` while it is on its way. */
function workspace(projectsDir: string | null | undefined, error?: string): RemoteHandle<WorkspaceSettings> {
  const data = projectsDir === undefined ? undefined : ({ projectsDir } as WorkspaceSettings);
  return { data, error, reload: () => {}, sentLoads: () => 0 };
}

function pane(projectsDir: string | null | undefined, error?: string): string {
  return renderToStaticMarkup(
    <NewSessionPane
      conn={conn}
      sessions={[]}
      workspace={workspace(projectsDir, error)}
      onStarted={() => {}}
      onWorktreesRemoved={() => {}}
      onRetry={() => {}}
      onOpenGetStarted={() => {}}
    />,
  );
}

test("before a projects folder is set, Sessions shows what is left before a first session, and no form, templates or routines", () => {
  const html = pane(null);

  expect(html).toContain("Checking what Trackwall needs before a first session…");
  expect(html).toContain(">Check again</button>");
  expect(html).toContain(">Settings › Get started</button>");
  expect(html).not.toContain("New task or session for the agent");
  expect(html).not.toContain("Routines");
});

test("with a projects folder and no setup left open in this browser, Sessions shows the form alone", () => {
  const html = pane("/home/you/Projects");

  expect(html).toContain("New task or session for the agent");
  expect(html).not.toContain("before a first session");
});

test("until the window has read the workspace settings, Sessions offers no form, which would ask a new install for routines", () => {
  const html = pane(undefined);

  expect(html).not.toContain("New task or session for the agent");
  expect(html).not.toContain("Routines");
  expect(html).not.toContain("before a first session");
});

test("when the window could not read the workspace settings, Sessions keeps the form, whose own reads say what is wrong", () => {
  const html = pane(undefined, "the daemon did not answer");

  expect(html).toContain("New task or session for the agent");
});
