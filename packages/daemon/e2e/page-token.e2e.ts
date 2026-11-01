import { describe, expect, test } from "bun:test";
import { useTrackwall } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall();

describe("the page's token in a browser (ADR-161)", () => {
  test("a page without a token asks for the address, refuses a wrong token, and keeps the right one for a new tab", async () => {
    const { origin, address } = trackwall();
    const page = await trackwall().openWithoutToken();

    const field = page.getByRole("textbox", { name: "Address of the daemon" });
    await field.fill(`${origin}/#token=from-before-a-restart`);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByText(/^Trackwall did not accept this token\. It gets a new one every time it starts/).waitFor();

    await field.fill(address);
    await page.getByRole("button", { name: "Connect" }).click();
    await field.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Fold the supervisor panel" }).waitFor();

    const tab = await page.context().newPage();
    await tab.goto(origin);
    await tab.getByRole("button", { name: "Fold the supervisor panel" }).waitFor();
    expect(await tab.getByRole("textbox", { name: "Address of the daemon" }).count()).toBe(0);
  }, 60_000);

  test("a token saved for another start of the daemon is forgotten without being sent, and the page asks for the address", async () => {
    const { origin, address } = trackwall();
    const page = await trackwall().openWithoutToken();
    const token = address.split("#token=")[1];
    await page.evaluate((saved) => localStorage.setItem("trackwall.token", saved), JSON.stringify({ token, instance: "an-earlier-start" }));
    await page.goto(origin);
    await page.getByRole("textbox", { name: "Address of the daemon" }).waitFor();
    expect(await page.evaluate(() => localStorage.getItem("trackwall.token"))).toBeNull();
  }, 60_000);
});
