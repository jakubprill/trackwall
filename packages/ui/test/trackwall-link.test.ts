import { expect, test } from "bun:test";
import type { TrackwallLinkTarget } from "@trackwall/protocol";
import { openTrackwallLink } from "../src/lib/trackwall-link.ts";

const SESSION = "0b7e3a52-5c1f-4c55-9a4e-2f1d7c3b9e10";

test("a valid link is opened with the target it points at", () => {
  const opened: [string, TrackwallLinkTarget][] = [];
  expect(openTrackwallLink(`trackwall://session/${SESSION}`, (url, target) => void opened.push([url, target]))).toBe(true);
  expect(openTrackwallLink("trackwall://repo/orders-api", (url, target) => void opened.push([url, target]))).toBe(true);
  expect(opened).toEqual([
    [`trackwall://session/${SESSION}`, { kind: "session", id: SESSION }],
    ["trackwall://repo/orders-api", { kind: "repo", id: "orders-api" }],
  ]);
});

test("something that is not a valid trackwall link opens nothing", () => {
  const opened: string[] = [];
  expect(openTrackwallLink("trackwall://repo/orders-api?run=1", (url) => void opened.push(url))).toBe(false);
  expect(openTrackwallLink("https://example.com", (url) => void opened.push(url))).toBe(false);
  expect(opened).toEqual([]);
});
