import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { showSessions, useTrackwall, waitForTerminal } from "./support/trackwall-ui.ts";

const FAKE_MISE = [process.execPath, join(import.meta.dir, "..", "test", "fixtures", "fake-mise.ts")];
/** The fake mise's `test` (see `test/fixtures/fake-mise.ts`): one failed test in a JUnit report and exit code 1. */
const SHOP_MISE = JSON.stringify({
  tasks: [{ name: "test" }],
  exits: { test: 1 },
  writes: {
    test: {
      "target/surefire-reports/TEST-shop.CartTest.xml": `<testsuite name="shop.CartTest"><testcase name="sums" classname="shop.CartTest" time="0.1"><failure message="expected: &lt;3&gt; but was: &lt;4&gt;" type="AssertionFailedError">AssertionFailedError</failure></testcase></testsuite>`,
    },
  },
});
const PROMPT = "Fix the cart sum";

const trackwall = useTrackwall({
  repos: { shop: { "README.md": "# shop\n", "fake-mise.json": SHOP_MISE, ".gitignore": "target/\ncalls.log\n" } },
  miseCommand: FAKE_MISE,
});

describe("a failed task retried on a stronger model", () => {
  test("after a failed verification one click starts the task again on the retry model from Settings, and the panel opens it", async () => {
    const { daemon } = trackwall();
    daemon.facade.workspace.setRetryModel("claude-opus-5.5");
    const page = await trackwall().open();
    await showSessions(page);
    await page.getByRole("textbox", { name: "Prompt for the agent" }).fill(PROMPT);
    await page.getByRole("button", { name: "Model for the agent: Copilot CLI default" }).click();
    await page.getByRole("textbox", { name: "Model for the agent" }).fill("gpt-5-mini");
    await page.getByRole("button", { name: "Create task" }).click();
    await waitForTerminal(page, "Argument: --model=gpt-5-mini");

    await page.getByRole("button", { name: "Verify" }).click();
    await page.getByRole("button", { name: "Details" }).click();
    const verification = page.getByRole("region", { name: "Verification" });
    await verification.getByText("1 test · 1 failed").waitFor();
    await page.getByRole("button", { name: "Retry on claude-opus-5.5" }).click();

    // The panel now shows the retry: its own session, started on the stronger model with the same prompt.
    await waitForTerminal(page, "Argument: --model=claude-opus-5.5");
    const tasks = daemon.facade.agents.sessions().tasks;
    const first = tasks.find((t) => t.retryOf === null);
    const retry = tasks.find((t) => t.retryOf !== null);
    expect(retry).toMatchObject({ prompt: PROMPT, model: "claude-opus-5.5", retryOf: first?.id, base: first?.base });
    expect(first?.model).toBe("gpt-5-mini");
  }, 90_000);
});
