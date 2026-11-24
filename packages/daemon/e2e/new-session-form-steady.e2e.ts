import { describe, expect, test } from "bun:test";
import type { Locator } from "playwright";
import { showSessions, useTrackwall } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall();

/** Where a control's top edge is on the page, which the next click of the user aims at. */
async function top(control: Locator): Promise<number> {
  const box = await control.boundingBox();
  if (box === null) throw new Error("the control is not on the page");
  return box.y;
}

describe("the New session form stays put under the mouse", () => {
  test("turning Own worktree off and on, opening More options and the stack trace leave every clicked control where it was", async () => {
    const page = await trackwall().open();
    await showSessions(page);
    const worktree = page.getByRole("button", { name: "Own worktree" });
    const moreOptions = page.getByRole("button", { name: /^More options/ });
    const stackTrace = page.getByRole("button", { name: "Stack trace" });
    await worktree.and(page.locator('[aria-pressed="true"]')).waitFor();
    await stackTrace.waitFor();
    const worktreeTop = await top(worktree);
    const moreOptionsTop = await top(moreOptions);

    await worktree.click();
    await stackTrace.waitFor({ state: "detached" });
    expect(await top(worktree)).toBe(worktreeTop);
    expect(await top(moreOptions)).toBe(moreOptionsTop);

    await worktree.click();
    await stackTrace.waitFor();
    expect(await top(worktree)).toBe(worktreeTop);

    await moreOptions.click();
    await page.getByRole("button", { name: "No approvals" }).waitFor();
    expect(await top(moreOptions)).toBe(moreOptionsTop);
    expect(await top(worktree)).toBe(worktreeTop);

    const stackTraceTop = await top(stackTrace);
    await stackTrace.click();
    await page.getByRole("textbox", { name: "Stack trace" }).waitFor();
    expect(await top(stackTrace)).toBe(stackTraceTop);
    expect(await top(worktree)).toBe(worktreeTop);
  }, 60_000);
});
