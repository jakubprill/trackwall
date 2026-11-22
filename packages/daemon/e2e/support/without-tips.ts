import type { BrowserContext } from "playwright";

/**
 * Tips and What's new (ADR-296) show on a new browser profile, which every page of the E2E tests has, and would stand
 * in the way of the other tests; so pages start with them off, as `trackwall.tips` in the page's storage says, unless a
 * test asks for them. A choice the test makes in the page stays, as the script only sets the key while it is missing.
 */
export async function withoutTips(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    try {
      if (localStorage.getItem("trackwall.tips") === null) localStorage.setItem("trackwall.tips", "off");
    } catch {
      // A page without storage of its own, such as the blank one a new tab starts on, has no tips either.
    }
  });
}
