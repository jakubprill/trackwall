import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILT_IN_TASK_TEMPLATES, taskTemplatesApi } from "@trackwall/protocol";
import { startSessionApi } from "./support/session-api.ts";
import { SLOW_TEST_TIMEOUT_MS } from "./support/test-timeouts.ts";

const TOKEN = "t".repeat(43);
let daemon: Awaited<ReturnType<typeof startSessionApi>>;

beforeAll(async () => {
  daemon = await startSessionApi(TOKEN);
}, SLOW_TEST_TIMEOUT_MS);

afterAll(() => daemon.stop());

function templateFile(name: string): string {
  return join(daemon.projects, ".trackwall", "task-templates", `${name}.md`);
}

async function titles(): Promise<string[]> {
  return (await daemon.post(taskTemplatesApi.list, {})).templates.map((t) => `${t.title} (${t.origin})`);
}

describe.skipIf(process.versions.bun === undefined)("task templates (ADR-251, HTTP through the facade)", () => {
  test("a new workspace lists the built-in templates, in their order", async () => {
    const { templates, problems } = await daemon.post(taskTemplatesApi.list, {});
    expect(templates).toEqual(BUILT_IN_TASK_TEMPLATES.map((t) => ({ ...t, origin: "built-in" })));
    expect(problems).toEqual([]);
  });

  test("the user saves a prompt as a template: it becomes a file named after its title and lists after the built-in ones", async () => {
    const saved = await daemon.post(taskTemplatesApi.save, {
      title: "Check a Flyway migration",
      prompt: "Read the migration <migration file> and say whether it locks a large table.",
    });
    expect(saved).toEqual({
      name: "check-a-flyway-migration",
      title: "Check a Flyway migration",
      prompt: "Read the migration <migration file> and say whether it locks a large table.",
      origin: "own",
    });
    expect(readFileSync(templateFile("check-a-flyway-migration"), "utf8")).toBe(
      "---\ntitle: Check a Flyway migration\n---\nRead the migration <migration file> and say whether it locks a large table.\n",
    );
    expect((await titles()).at(-1)).toBe("Check a Flyway migration (own)");

    await daemon.post(taskTemplatesApi.remove, { name: "check-a-flyway-migration" });
    expect(existsSync(templateFile("check-a-flyway-migration"))).toBe(false);
    expect(await titles()).not.toContain("Check a Flyway migration (own)");
  });

  test("an own template saved under a built-in's title takes its place in the list, and removing it brings the built-in back", async () => {
    await daemon.post(taskTemplatesApi.save, {
      title: "Fix a bug",
      prompt: "Bug: <what happens>. Write the failing test in JUnit 5 first.",
    });
    const { templates } = await daemon.post(taskTemplatesApi.list, {});
    expect(templates.filter((t) => t.name === "fix-a-bug")).toEqual([
      { name: "fix-a-bug", title: "Fix a bug", prompt: "Bug: <what happens>. Write the failing test in JUnit 5 first.", origin: "own" },
    ]);
    expect(templates.findIndex((t) => t.name === "fix-a-bug")).toBe(BUILT_IN_TASK_TEMPLATES.findIndex((t) => t.name === "fix-a-bug"));

    await daemon.post(taskTemplatesApi.remove, { name: "fix-a-bug" });
    expect(await titles()).toContain("Fix a bug (built-in)");
  });

  test("a template written by hand counts at once, and a file that holds no template is a problem of the list, not a template", async () => {
    writeFileSync(templateFile("release-notes"), "---\ntitle: Write release notes\n---\nList the changes since <tag>.\n");
    writeFileSync(templateFile("broken"), "no frontmatter here\n");
    writeFileSync(templateFile("hidden"), "---\ntitle: Looks fine\n---\nFix it\u{E0041} quietly\n");
    const { templates, problems } = await daemon.post(taskTemplatesApi.list, {});
    expect(templates.at(-1)).toEqual({
      name: "release-notes",
      title: "Write release notes",
      prompt: "List the changes since <tag>.",
      origin: "own",
    });
    expect(problems.map((p) => p.file).sort()).toEqual(["broken.md", "hidden.md"]);
    expect(templates.some((t) => t.name === "hidden")).toBe(false);
  });

  test.skipIf(process.platform === "win32")("a link in the templates folder is a problem, never read through", async () => {
    const outside = join(daemon.projects, "outside.md");
    writeFileSync(outside, "---\ntitle: Outside\n---\nRead from outside the folder\n");
    symlinkSync(outside, templateFile("linked"));
    const { templates, problems } = await daemon.post(taskTemplatesApi.list, {});
    expect(templates.some((t) => t.name === "linked")).toBe(false);
    expect(problems.map((p) => p.file)).toContain("linked.md");
  });

  test("a title without a letter or digit, or with invisible characters, is refused", async () => {
    await expect(daemon.post(taskTemplatesApi.save, { title: "—", prompt: "p" })).rejects.toThrow("at least one letter or digit");
    await expect(daemon.post(taskTemplatesApi.save, { title: "Fix\u{200B}", prompt: "p" })).rejects.toThrow("invisible");
  });

  test("the templates folder is made where missing, also when the user removed it", async () => {
    const dir = join(daemon.projects, ".trackwall", "task-templates");
    rmSync(dir, { recursive: true, force: true });
    const { templates } = await daemon.post(taskTemplatesApi.list, {});
    expect(templates.map((t) => t.name)).toEqual(BUILT_IN_TASK_TEMPLATES.map((t) => t.name));
    expect(existsSync(dir)).toBe(true);
  });
});
