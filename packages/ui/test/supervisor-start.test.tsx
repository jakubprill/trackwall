import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SupervisorStart } from "../src/components/SupervisorStart.tsx";
import type { Connection } from "../src/lib/connection.ts";
import type { SupervisorSummary } from "../src/lib/supervisor.ts";
import type { DayStartHandle } from "../src/lib/use-day-start.ts";

/** Rendering to markup sends no request, so the connection is never used. */
const conn = {} as Connection;
const noSupervisor: SupervisorSummary = {
  session: undefined,
  work: [],
  delegated: 0,
  waitingProposals: 0,
  sessionWaits: false,
  waits: false,
  listed: false,
  resumable: false,
};
const noDayStart: DayStartHandle = { run: null, running: false, error: undefined, start: () => {} };

test("before a projects folder is set, the start card asks for one and offers Get started instead of the starts", () => {
  const html = renderToStaticMarkup(
    <SupervisorStart
      conn={conn}
      supervisor={noSupervisor}
      day={noDayStart}
      lastStart="day"
      projectsDir={null}
      onStart={() => {}}
      onChanged={() => {}}
      onOpenGetStarted={() => {}}
    />,
  );

  expect(html).toContain("Set your projects folder first");
  expect(html).toContain(">Get started</button>");
  expect(html).not.toContain(">Start my day</button>");
  expect(html).not.toContain(">New conversation</button>");
});

test("with a projects folder the start card offers Start my day first, as before", () => {
  const html = renderToStaticMarkup(
    <SupervisorStart
      conn={conn}
      supervisor={noSupervisor}
      day={noDayStart}
      lastStart="day"
      projectsDir="/home/you/Projects"
      onStart={() => {}}
      onChanged={() => {}}
      onOpenGetStarted={() => {}}
    />,
  );

  expect(html).toContain(">Start my day</button>");
  expect(html).toContain(">New conversation</button>");
  expect(html).not.toContain("Set your projects folder first");
});

test("while the workspace settings are still on their way, the start card keeps its starts rather than hide them", () => {
  const html = renderToStaticMarkup(
    <SupervisorStart
      conn={conn}
      supervisor={noSupervisor}
      day={noDayStart}
      lastStart="day"
      projectsDir={undefined}
      onStart={() => {}}
      onChanged={() => {}}
      onOpenGetStarted={() => {}}
    />,
  );

  expect(html).toContain(">Start my day</button>");
  expect(html).not.toContain("Set your projects folder first");
});
