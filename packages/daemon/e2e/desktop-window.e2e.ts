import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { useTrackwall } from "./support/trackwall-ui.ts";

const SCENE_TIMEOUT_MS = 20_000;
const TEST_TIMEOUT_MS = 40_000;

describe("the main window under the desktop shell's CSP", () => {
  const trackwall = useTrackwall();

  test(
    "Home draws the 3D scene of the repos and gets the daemon's events, with nothing refused by the CSP",
    async () => {
      // A repo with a change has a label in the scene (a clean one has none), so the label shows the scene was built.
      writeFileSync(join(trackwall().daemon.projects, "shop", "notes.txt"), "to do\n");
      const { page, problems, eventsArrived, close } = await trackwall().openDesktopWindow();

      const label = page.locator("div:has(> canvas)").getByText("shop", { exact: true });
      // Either way the scene ends, so that a refused scene fails on what the CSP refused rather than on a timeout.
      await label.or(page.getByText("The 3D view is unavailable here")).waitFor({ timeout: SCENE_TIMEOUT_MS });
      expect(problems).toEqual([]);
      expect(await label.isVisible()).toBe(true);
      await eventsArrived;
      expect(problems).toEqual([]);
      await close();
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a 3D view that fails to load leaves a message in its place, and the rest of the window keeps working",
    async () => {
      const { page, problems, close } = await trackwall().openDesktopWindow(/\/HomeCanvas-[^/]*\.js$/);

      await page.getByText("The 3D view is unavailable here").waitFor({ timeout: SCENE_TIMEOUT_MS });
      await page
        .getByRole("navigation", { name: "Views" })
        .getByRole("button", { name: /^Repos/ })
        .click();
      await page.getByText("shop", { exact: true }).first().waitFor({ timeout: SCENE_TIMEOUT_MS });
      // Only the failed chunk, which the boundary caught: nothing uncaught, nothing refused by the CSP.
      expect(problems).toEqual([
        expect.stringContaining("status of 500"),
        expect.stringContaining("Failed to fetch dynamically imported module"),
      ]);
      await close();
    },
    TEST_TIMEOUT_MS,
  );
});
