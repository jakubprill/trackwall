import { expect, test } from "bun:test";
import { parseTrackwallLink, trackwallLink, trackwallLinkCandidates } from "../src/links.ts";

const ID = "0b7e3a52-5c1f-4c55-9a4e-2f1d7c3b9e10";

test("a link names the kind and the id after the trackwall scheme", () => {
  expect(trackwallLink("repo", "orders-api")).toBe("trackwall://repo/orders-api");
  expect(trackwallLink("task", ID)).toBe(`trackwall://task/${ID}`);
});

test("a link to a repo, a session or a task parses to what it shows", () => {
  expect(parseTrackwallLink("trackwall://repo/orders-api")).toEqual({ kind: "repo", id: "orders-api" });
  expect(parseTrackwallLink(`trackwall://session/${ID}`)).toEqual({ kind: "session", id: ID });
  expect(parseTrackwallLink(`trackwall://task/${ID}/`)).toEqual({ kind: "task", id: ID });
});

test("the scheme and the kind have no case, and a session or task id is taken in lower case", () => {
  expect(parseTrackwallLink(`TrackWall://Session/${ID.toUpperCase()}`)).toEqual({ kind: "session", id: ID });
});

test("anything but one valid id of a known kind is not a link", () => {
  expect(parseTrackwallLink("https://repo/orders-api")).toBeUndefined();
  expect(parseTrackwallLink("trackwall://service/orders-api")).toBeUndefined();
  expect(parseTrackwallLink("trackwall://repo/orders-api/main")).toBeUndefined();
  expect(parseTrackwallLink("trackwall://repo/orders-api?run=1")).toBeUndefined();
  expect(parseTrackwallLink("trackwall://repo/orders-api#top")).toBeUndefined();
  expect(parseTrackwallLink("trackwall://repo/Orders")).toBeUndefined();
  expect(parseTrackwallLink("trackwall://session/1234")).toBeUndefined();
  expect(parseTrackwallLink(" trackwall://repo/orders-api")).toBeUndefined();
});

test("candidates in running text leave out the full stop that ends a sentence", () => {
  const text = "Open trackwall://repo/orders-api. Then (trackwall://repo/billing_) too.";
  expect([...text.matchAll(trackwallLinkCandidates())].map((m) => m[0])).toEqual([
    "trackwall://repo/orders-api",
    "trackwall://repo/billing_",
  ]);
});
