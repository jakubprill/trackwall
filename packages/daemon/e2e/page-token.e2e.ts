import { describe, expect, test } from "bun:test";
import { readDaemonFile } from "../src/infra/discovery.ts";
import { useTrackwall } from "./support/trackwall-ui.ts";

const trackwall = useTrackwall();

describe("the page's token in a browser (ADR-161)", () => {
  test("an address with a one-time code opens the page, leaves the address bar, and opens nothing a second time", async () => {
    const { origin, address, daemon } = trackwall();
    const page = await trackwall().openWithoutToken();
    const once = address();
    await page.goto(once);
    await page.getByRole("button", { name: /^Pin the supervisor panel open/ }).waitFor();
    expect(page.url()).toBe(`${origin}/`);
    const saved = await page.evaluate(() => localStorage.getItem("trackwall.token"));
    expect(JSON.parse(saved ?? "{}").token).toBe(readDaemonFile(daemon.home)?.token);

    // The same address in another browser, as a copy from the history or a synced history gives it.
    const elsewhere = await trackwall().openWithoutToken();
    await elsewhere.goto(once);
    await elsewhere.getByRole("textbox", { name: "Address of the daemon" }).waitFor();
    expect(elsewhere.url()).toBe(`${origin}/`);
    expect(await elsewhere.evaluate(() => localStorage.getItem("trackwall.token"))).toBeNull();
  }, 60_000);

  test("a page without a token asks for the address, refuses a spent code, and keeps the token of a fresh one for a new tab", async () => {
    const { origin, address } = trackwall();
    const spent = address();
    const used = await trackwall().openWithoutToken();
    await used.goto(spent);
    await used.getByRole("button", { name: /^Pin the supervisor panel open/ }).waitFor();
    const page = await trackwall().openWithoutToken();

    const field = page.getByRole("textbox", { name: "Address of the daemon" });
    await field.fill(spent);
    await page.getByRole("button", { name: "Connect" }).click();
    await page.getByText(/one-time code was used already/).waitFor();

    await field.fill(address());
    await page.getByRole("button", { name: "Connect" }).click();
    await field.waitFor({ state: "detached" });
    await page.getByRole("button", { name: /^Pin the supervisor panel open/ }).waitFor();

    const tab = await page.context().newPage();
    await tab.goto(origin);
    await tab.getByRole("button", { name: /^Pin the supervisor panel open/ }).waitFor();
    expect(await tab.getByRole("textbox", { name: "Address of the daemon" }).count()).toBe(0);
  }, 60_000);

  test("a token saved for another start of the daemon is forgotten without being sent, and the page asks for the address", async () => {
    const { origin, daemon } = trackwall();
    const page = await trackwall().openWithoutToken();
    const token = readDaemonFile(daemon.home)?.token;
    const saved = JSON.stringify({ token, instance: "an-earlier-start" });
    await page.evaluate((value) => localStorage.setItem("trackwall.token", value), saved);
    await page.goto(origin);
    await page.getByRole("textbox", { name: "Address of the daemon" }).waitFor();
    expect(await page.evaluate(() => localStorage.getItem("trackwall.token"))).toBeNull();
  }, 60_000);
});
