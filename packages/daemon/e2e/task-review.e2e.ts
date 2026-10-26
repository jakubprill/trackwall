import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { GetReviewCommentsResult } from "@trackwall/protocol";
import { commitFiles } from "../test/support/git-repo.ts";
import { sessionRow, showSessions, startTrackwall, type Trackwall, typeInTerminal, waitForTerminal } from "./support/trackwall-ui.ts";

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
const PROMPT = "Fix the cart sum and say in the README how to run shop";

// Unset when the start failed, so `afterAll` stops only what started.
let trackwall: Trackwall | undefined;

// A limit above the default 5 s: Chromium and the daemon start slowly on a Windows runner.
beforeAll(async () => {
  trackwall = await startTrackwall({
    // What the fake mise writes stays out of the task's changes, as a build's output does in a real repo.
    repos: { shop: { "README.md": "# shop\n", "fake-mise.json": SHOP_MISE, ".gitignore": "target/\ncalls.log\n" } },
    miseCommand: FAKE_MISE,
  });
}, 60_000);

afterAll(async () => {
  await trackwall?.stop();
}, 30_000);

describe("an agent task, verified and reviewed", () => {
  test("the user creates a task, verifies it, comments on a line of its changes, and the agent gets the comment once its turn ends", async () => {
    if (trackwall === undefined) throw new Error("Trackwall did not start");
    const { daemon } = trackwall;
    const page = await trackwall.open();
    await showSessions(page);
    await page.getByRole("textbox", { name: "Prompt for the agent" }).fill(PROMPT);
    await page.getByRole("button", { name: "Create task" }).click();
    await waitForTerminal(page, `--interactive=${PROMPT}`);

    await page.getByRole("button", { name: "Verify" }).click();
    const verification = page.getByRole("region", { name: "Verification" });
    await verification.getByText("1 test · 1 failed").waitFor();
    await verification.getByRole("list", { name: "Failed tests" }).getByText("sums").waitFor();

    // The agent's work: a commit on the task's branch in its worktree.
    const task = daemon.facade.agents.sessions().tasks.find((t) => t.prompt === PROMPT);
    if (task === undefined) throw new Error("the task is not on the list");
    commitFiles(task.worktree, { "README.md": "# shop\n\nRun it with `mise run dev`.\n" }, "Say how to run shop");
    await page.getByRole("tab", { name: "Changes" }).click();
    await page.getByRole("button", { name: "Comment on line 3 of README.md" }).click();
    await page.getByRole("textbox", { name: "Comment on line 3 of README.md" }).fill("Say which port it listens on.");
    await page.getByRole("button", { name: "Add comment" }).click();
    await page.getByRole("button", { name: "Send 1 comment to the agent" }).click();
    await page.getByText("Sent: the agent gets your review once it waits for input again.").waitFor();

    // The agent finishes its turn: a line, the approval of its command, and the turn ends.
    await page.getByRole("tab", { name: "Terminal" }).click();
    await typeInTerminal(page, "go on\r");
    // The answer once the list shows the request, as the user sees it: a key the daemon reads before the request is
    // text typed into the input box, and the review would wait for the user to send it.
    await sessionRow(page, "shop").getByText("asking for approval").waitFor();
    await page.keyboard.type("1");
    await waitForTerminal(page, "Thinking about: The user sent a review of your changes in Trackwall");

    const session = daemon.facade.agents.sessions().sessions.find((s) => s.task === task.id);
    if (session === undefined) throw new Error("the task has no session");
    const agent = await trackwall.agentOf(session.id);
    const read = GetReviewCommentsResult.parse((await agent.callTool({ name: "get_review_comments", arguments: {} })).structuredContent);
    expect(read.comments).toEqual([
      { path: "README.md", side: "new", line: 3, code: "Run it with `mise run dev`.", text: "Say which port it listens on." },
    ]);
  }, 90_000);
});
