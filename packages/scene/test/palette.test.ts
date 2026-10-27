import { expect, test } from "bun:test";
import { repoStateColor, type ScenePalette, sessionStateColor } from "../src/palette.ts";

const palette: ScenePalette = {
  primary: "#000001",
  warning: "#000002",
  destructive: "#000003",
  muted: "#000004",
  idle: "#000005",
  body: "#000006",
  plate: "#000007",
};

test("an idle session has the calm colour, a session waiting for you the warning colour", () => {
  expect(sessionStateColor("idle", palette)).toBe("#000005");
  expect(sessionStateColor("attention", palette)).toBe("#000002");
  expect(sessionStateColor("working", palette)).toBe("#000001");
  expect(sessionStateColor("error", palette)).toBe("#000003");
  expect(sessionStateColor("done", palette)).toBe("#000004");
});

test("a clean repo has the muted colour, not the idle one, which is nearly the background", () => {
  expect(repoStateColor("clean", palette)).toBe("#000004");
  expect(repoStateColor("changed", palette)).toBe("#000002");
});
