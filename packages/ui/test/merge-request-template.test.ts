import { describe, expect, test } from "bun:test";
import { fillTemplate } from "../src/lib/merge-request-template.ts";

describe("Trackwall's draft in the repo's template", () => {
  test("a template in Polish gets the summary under its description and the evidence under its testing heading", () => {
    expect(fillTemplate("### Opis zmian\n\n### Jak sprawdzić\n", "Fixed it.", "- Verification: passed")).toBe(
      "### Opis zmian\n\nFixed it.\n\n### Jak sprawdzić\n\n- Verification: passed",
    );
  });

  test("a heading that asks what to test is a testing heading, not the summary's", () => {
    expect(fillTemplate("## What to test\n", "Fixed it.", "- Verification: passed")).toBe(
      "Fixed it.\n\n## What to test\n\n- Verification: passed",
    );
  });

  test("without matching headings the summary goes above the template and the evidence below it", () => {
    expect(fillTemplate("Closes #\n\n- [ ] Reviewed", "Fixed it.", "- Verification: passed")).toBe(
      "Fixed it.\n\nCloses #\n\n- [ ] Reviewed\n\n- Verification: passed",
    );
  });

  test("a heading inside a fenced code block of the template is left alone", () => {
    expect(fillTemplate("```md\n## Summary\n```\n## Summary\n", "Fixed it.", "")).toBe("```md\n## Summary\n```\n## Summary\n\nFixed it.");
  });
});
