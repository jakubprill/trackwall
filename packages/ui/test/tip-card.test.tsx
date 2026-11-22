import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TipCard } from "../src/components/TipCard.tsx";

test("a tip names the control it explains, links the page that tells more, and offers Got it and Turn off tips (ADR-296)", () => {
  const markup = renderToStaticMarkup(<TipCard tip="own-worktree" onDocs={() => {}} onTurnOff={() => {}} onGotIt={() => {}} />);

  expect(markup).toContain('aria-label="Tip: Own worktree"');
  expect(markup).toContain("On, the prompt becomes a task on a branch of its own");
  expect(markup).toContain("Agent tasks");
  expect(markup).toContain("Turn off tips");
  expect(markup).toContain("Got it");
});

test("a page that did not open says why under the tip", () => {
  const markup = renderToStaticMarkup(
    <TipCard tip="evidence" docsError="Trackwall cannot open links here" onDocs={() => {}} onTurnOff={() => {}} onGotIt={() => {}} />,
  );

  expect(markup).toContain("Trackwall cannot open links here");
});
