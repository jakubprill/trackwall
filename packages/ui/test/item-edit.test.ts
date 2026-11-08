import { describe, expect, test } from "bun:test";
import type { BoardItem } from "@trackwall/protocol";
import { conflictNotice, planSave, shownText, withoutFields } from "../src/lib/item-edit.ts";

const base: BoardItem = {
  id: "0b5b1f0e-6a39-4c5e-9d43-1f2b0c7a9e11",
  kind: "item",
  title: "Retry the export",
  body: "Plan: retry three times.",
  parent: null,
  column: "ready",
  order: 1,
  repos: ["shop"],
  link: null,
  createdBy: { kind: "user" },
  createdAt: "2026-11-08T10:00:00.000Z",
  updatedAt: "2026-11-08T10:00:00.000Z",
};
const AGENT_NOTES = "Plan: retry three times.\n\nFound: the job runs at 02:00.";
const byAgent: BoardItem = { ...base, body: AGENT_NOTES, updatedAt: "2026-11-08T10:05:00.000Z" };

describe("editing an item's text while others write to it (ADR-232)", () => {
  test("the user renamed the item while an agent wrote notes: the form shows the agent's notes and saves only the title", () => {
    const draft = { title: "Retry the invoice export" };

    expect(shownText(draft, byAgent)).toEqual({ title: "Retry the invoice export", body: AGENT_NOTES, link: "" });
    expect(planSave(base, byAgent, draft)).toEqual({
      kind: "save",
      change: { title: "Retry the invoice export" },
      expectedUpdatedAt: "2026-11-08T10:05:00.000Z",
    });
  });

  test("the user and an agent both changed the notes: Save waits for the user's choice", () => {
    expect(planSave(base, byAgent, { body: "Plan: retry five times." })).toEqual({ kind: "conflict", fields: ["body"] });
  });

  test("Use theirs drops the user's notes, so the form shows the agent's and saves only the rest", () => {
    const draft = withoutFields({ title: "Retry the invoice export", body: "Plan: retry five times." }, ["body"]);

    expect(shownText(draft, byAgent).body).toBe(AGENT_NOTES);
    expect(planSave(base, byAgent, draft)).toMatchObject({ kind: "save", change: { title: "Retry the invoice export" } });
  });

  test("after Keep mine the edit builds on the agent's version, so the user's notes replace the agent's knowingly", () => {
    expect(planSave(byAgent, byAgent, { body: "Plan: retry five times." })).toEqual({
      kind: "save",
      change: { body: "Plan: retry five times." },
      expectedUpdatedAt: "2026-11-08T10:05:00.000Z",
    });
  });

  test("the same text typed by both is no conflict, and a column moved by a task touches none of the text", () => {
    const moved: BoardItem = { ...base, column: "in_progress", updatedAt: "2026-11-08T10:06:00.000Z" };

    expect(planSave(base, byAgent, { body: AGENT_NOTES })).toEqual({ kind: "unchanged" });
    expect(planSave(base, moved, { body: "Plan: retry five times." })).toMatchObject({
      kind: "save",
      expectedUpdatedAt: "2026-11-08T10:06:00.000Z",
    });
  });

  test("a link typed with spaces is saved trimmed, an emptied one as none, and text typed back to the original is no change", () => {
    const linked: BoardItem = { ...base, link: "https://tracker.example.org/T-1" };

    expect(planSave(base, base, { link: "  https://tracker.example.org/T-1 " })).toMatchObject({
      change: { link: "https://tracker.example.org/T-1" },
    });
    expect(planSave(linked, linked, { link: " " })).toMatchObject({ change: { link: null } });
    expect(planSave(base, base, { title: " Retry the export " })).toEqual({ kind: "unchanged" });
  });

  test("notes typed back to the original while the agent changed them are a conflict, so the form never hides the agent's text", () => {
    expect(planSave(base, byAgent, { body: base.body })).toEqual({ kind: "conflict", fields: ["body"] });
  });

  test("only the fields both changed are a conflict, in the form's order; the link only the agent changed is not", () => {
    const both: BoardItem = { ...byAgent, title: "Retry the export at night", link: "https://tracker.example.org/T-1" };

    expect(planSave(base, both, { body: "Plan: retry five times.", title: "Retry the invoice export" })).toEqual({
      kind: "conflict",
      fields: ["title", "body"],
    });
  });

  test("an emptied field shows empty, an emptied link where there was none is no change, and an emptied title cannot be saved", () => {
    expect(shownText({ body: "" }, byAgent).body).toBe("");
    expect(planSave(base, base, { link: "" })).toEqual({ kind: "unchanged" });
    expect(planSave(base, base, { title: "  " })).toEqual({ kind: "no_title" });
  });

  test("the notice names the fields both changed in plain words", () => {
    expect(conflictNotice(["body"])).toBe("You and someone else (maybe an agent) both changed the notes since you started this edit.");
    expect(conflictNotice(["title", "body", "link"])).toBe(
      "You and someone else (maybe an agent) both changed the title, notes and ticket link since you started this edit.",
    );
  });
});
