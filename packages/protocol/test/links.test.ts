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

const candidates = (text: string) => [...text.matchAll(trackwallLinkCandidates())].map((m) => m[0]);

test("candidates in running text leave out the full stop, question mark or bracket that ends a sentence", () => {
  expect(candidates("Open trackwall://repo/orders-api. Then (trackwall://repo/billing_) too. Seen trackwall://repo/web?")).toEqual([
    "trackwall://repo/orders-api",
    "trackwall://repo/billing_",
    "trackwall://repo/web",
  ]);
});

test("a longer address is no candidate, rather than a shorter link than the text shows", () => {
  expect(candidates("see trackwall://repo/orders/main, trackwall://repo/orders?run=1 and xtrackwall://repo/a")).toEqual([]);
});
