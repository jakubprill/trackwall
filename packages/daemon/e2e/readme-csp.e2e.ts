import { describe, expect, test } from "bun:test";
import { useTrackwall } from "./support/trackwall-ui.ts";

const PIXEL = "http://pixel.example.test/p.png";
/** A Mermaid label with HTML, which `strict` mode lets through: an image from outside, a tracking pixel. */
const README = `# shop\n\n\`\`\`mermaid\nflowchart LR\n  A["<img src='${PIXEL}' width=10> start"] --> B[finish]\n\`\`\`\n`;

// The image refused is the point of the test; any other refusal fails it.
const trackwall = useTrackwall(
  { repos: { shop: { "README.md": README } }, miseCommand: ["mise"] },
  /^img-src refused http:\/\/pixel\.example\.test\//,
);

describe("the UI in a browser tab under the daemon's Content-Security-Policy", () => {
  test("a README's Mermaid diagram draws, and an image from outside in its label never leaves the browser", async () => {
    const page = await trackwall().open();
    // Settles with the first fate of the image: refused in the page, or a request that reached the network.
    const { promise: pixel, resolve } = Promise.withResolvers<string>();
    page.on("requestfailed", (request) => {
      if (request.url() === PIXEL) resolve(`refused: ${request.failure()?.errorText}`);
    });
    await page.route(PIXEL, (route) => {
      resolve("reached the network");
      return route.abort();
    });

    await page
      .getByRole("navigation", { name: "Views" })
      .getByRole("button", { name: /^Repos/ })
      .click();
    await page.getByText("shop", { exact: true }).first().click();
    await page.getByRole("tab", { name: "README" }).click();
    await page.locator("svg").filter({ hasText: "finish" }).first().waitFor();

    expect(await pixel).toBe("refused: csp");
    await page.close();
  }, 60_000);
});
