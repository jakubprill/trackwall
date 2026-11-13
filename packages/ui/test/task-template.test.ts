import { describe, expect, test } from "bun:test";
import { BUILT_IN_TASK_TEMPLATES, type TaskTemplateEntry, taskTemplateNameOf } from "@trackwall/protocol";
import { placeholdersLeft, promptWithTemplate, templateSave } from "../src/lib/task-template.ts";

const FIX_TEST = "The test <test name> fails. Fix it and run <test name> again.";
const BUMP = "Update <dependency> to <version>.";

describe("picking a task template (ADR-251)", () => {
  test("an empty prompt becomes the template, with its first placeholder selected to type over", () => {
    const { prompt, selection } = promptWithTemplate("  ", null, FIX_TEST);
    expect(prompt).toBe(FIX_TEST);
    expect(selection).toEqual({ start: 9, end: 20 });
    expect(prompt.slice(9, 20)).toBe("<test name>");
  });

  test("a prompt still exactly the template picked before is replaced by the next template", () => {
    const { prompt, selection } = promptWithTemplate(FIX_TEST, FIX_TEST, BUMP);
    expect(prompt).toBe(BUMP);
    expect(selection).toEqual({ start: 7, end: 19 });
  });

  test("text the user wrote is kept, and the template goes below it with its own placeholder selected", () => {
    const written = "The checkout page breaks <b> tags.\n";
    const { prompt, selection } = promptWithTemplate(written, FIX_TEST, BUMP);
    expect(prompt).toBe("The checkout page breaks <b> tags.\n\nUpdate <dependency> to <version>.");
    // The user's own `<b>` is not taken for the template's placeholder.
    expect(prompt.slice(selection?.start, selection?.end)).toBe("<dependency>");
  });

  test("a template without placeholders selects nothing", () => {
    expect(promptWithTemplate("", null, "Explain the build.").selection).toBeNull();
  });

  test("code in a prompt is not a placeholder: only lowercase words in angle brackets are", () => {
    const { prompt, selection } = promptWithTemplate("", null, "Return a List<String> from <method name>.");
    expect(prompt.slice(selection?.start, selection?.end)).toBe("<method name>");
  });
});

describe("placeholders left to fill in", () => {
  test("lists the template's placeholders still in the prompt, each once", () => {
    expect(placeholdersLeft(FIX_TEST, FIX_TEST)).toEqual(["<test name>"]);
    expect(placeholdersLeft("Update lodash to <version>.", BUMP)).toEqual(["<version>"]);
    expect(placeholdersLeft("Update lodash to 4.17.21.", BUMP)).toEqual([]);
  });

  test("angle brackets the user typed are never reported, and without a template nothing is", () => {
    expect(placeholdersLeft("Wrap it in a <section> and update <version>.", BUMP)).toEqual(["<version>"]);
    expect(placeholdersLeft("Wrap it in a <section>.", null)).toEqual([]);
  });
});

function entry(name: string, origin: TaskTemplateEntry["origin"]): TaskTemplateEntry {
  return { name, title: name, prompt: "p", origin };
}

describe("saving the prompt as a template", () => {
  const templates = [entry("fix-a-bug", "built-in"), entry("release-notes", "own")];

  test("a new title makes a new template named after it", () => {
    expect(templateSave("Check the Flyway migration", templates)).toEqual({ kind: "new", name: "check-the-flyway-migration" });
  });

  test("the title of an existing template replaces it, a built-in one as well as the user's own", () => {
    expect(templateSave("Fix a bug", templates)).toMatchObject({ kind: "replaces", template: { origin: "built-in" } });
    expect(templateSave("Release notes!", templates)).toMatchObject({ kind: "replaces", template: { origin: "own" } });
  });

  test("a title without a letter or digit cannot name a template", () => {
    expect(templateSave(" — ", templates)).toEqual({ kind: "needs-title" });
  });
});

describe("template names (protocol)", () => {
  test("a name keeps the title's letters without accents, lowercased and joined by -", () => {
    expect(taskTemplateNameOf("Napraw łamiący się test — szybko")).toBe("napraw-lamiacy-sie-test-szybko");
    expect(taskTemplateNameOf("Bump   Spring Boot to 3.5")).toBe("bump-spring-boot-to-3-5");
  });

  test("a long title is cut at a word to the name's 60 characters", () => {
    const name = taskTemplateNameOf("word ".repeat(30));
    expect(name?.length).toBeLessThanOrEqual(60);
    expect(name?.endsWith("-")).toBe(false);
  });

  test("every built-in template is named after its title, so saving under its title replaces it", () => {
    for (const template of BUILT_IN_TASK_TEMPLATES) expect(taskTemplateNameOf(template.title)).toBe(template.name);
  });
});
