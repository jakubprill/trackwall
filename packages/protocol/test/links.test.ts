import { expect, test } from "bun:test";
import { trackwallLink } from "../src/links.ts";

test("a link names the kind and the id after the trackwall scheme", () => {
  expect(trackwallLink("repo", "orders-api")).toBe("trackwall://repo/orders-api");
  expect(trackwallLink("task", "0b7e3a52-5c1f-4c55-9a4e-2f1d7c3b9e10")).toBe("trackwall://task/0b7e3a52-5c1f-4c55-9a4e-2f1d7c3b9e10");
});
