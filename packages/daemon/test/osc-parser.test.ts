import { describe, expect, test } from "bun:test";
import { OscParser } from "../src/modules/agents/osc-parser.ts";

describe("OSC parser", () => {
  test("picks out sequences ended by BEL and ESC \\ from between plain output", () => {
    const parser = new OscParser();
    expect(parser.feed("text\x1b]9;4;3;0\x07more\x1b]0;Fixing the test\x1b\\end\x1b[2J")).toEqual([
      { code: "9", data: "4;3;0" },
      { code: "0", data: "Fixing the test" },
    ]);
  });

  test("puts together a sequence split between chunks, also right after ESC", () => {
    const parser = new OscParser();
    expect(parser.feed("a\x1b")).toEqual([]);
    expect(parser.feed("]9;4;")).toEqual([]);
    expect(parser.feed("0;0\x1b")).toEqual([]);
    expect(parser.feed("\\b")).toEqual([{ code: "9", data: "4;0;0" }]);
  });

  test("ESC without \\ breaks the sequence, and the next one starts normally", () => {
    const parser = new OscParser();
    expect(parser.feed("\x1b]0;broken\x1b[0m\x1b]2;whole\x07")).toEqual([{ code: "2", data: "whole" }]);
  });

  test("ESC ] right after a broken sequence starts the next one at once", () => {
    expect(new OscParser().feed("\x1b]0;title\x1b]9;4;3;0\x07")).toEqual([{ code: "9", data: "4;3;0" }]);
  });

  test("a sequence without a semicolon has an empty data string", () => {
    expect(new OscParser().feed("\x1b]110\x07")).toEqual([{ code: "110", data: "" }]);
  });

  test("a sequence that is too long is skipped whole, and the parser keeps working", () => {
    const parser = new OscParser();
    expect(parser.feed(`\x1b]1337;File=${"x".repeat(10_000)}\x07`)).toEqual([]);
    expect(parser.feed("\x1b]9;4;1;50\x07")).toEqual([{ code: "9", data: "4;1;50" }]);
  });
});
