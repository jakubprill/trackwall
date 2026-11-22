import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WhatsNewStrip } from "../src/components/WhatsNew.tsx";
import type { Connection } from "../src/lib/connection.ts";
import { WHATS_NEW } from "../src/lib/whats-new.ts";

/** Rendering to markup sends no request, so the connection is never used. */
const conn = {} as Connection;

test("the strip counts the changes and gives each its own Show, named after the change for a screen reader (ADR-296)", () => {
  const markup = renderToStaticMarkup(<WhatsNewStrip conn={conn} entries={WHATS_NEW} onShow={() => {}} onDismiss={() => {}} />);

  expect(markup).toContain(`${WHATS_NEW.length} changes worth a look`);
  for (const entry of WHATS_NEW) expect(markup).toContain(`aria-label="Show ${entry.title}"`);
  expect(markup).toContain("Release notes");
  expect(markup).toContain("Dismiss");
});
