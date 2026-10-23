import { describe, expect, test } from "bun:test";
import { OscParser } from "../src/modules/agents/osc-parser.ts";

describe("parser OSC", () => {
  test("wyłuskuje sekwencje zakończone BEL i ESC \\ spomiędzy zwykłego wyjścia", () => {
    const parser = new OscParser();
    expect(parser.feed("tekst\x1b]9;4;3;0\x07dalej\x1b]0;Naprawa testu\x1b\\koniec\x1b[2J")).toEqual([
      { code: "9", data: "4;3;0" },
      { code: "0", data: "Naprawa testu" },
    ]);
  });

  test("składa sekwencję przeciętą między kawałkami, także zaraz po ESC", () => {
    const parser = new OscParser();
    expect(parser.feed("a\x1b")).toEqual([]);
    expect(parser.feed("]9;4;")).toEqual([]);
    expect(parser.feed("0;0\x1b")).toEqual([]);
    expect(parser.feed("\\b")).toEqual([{ code: "9", data: "4;0;0" }]);
  });

  test("ESC bez \\ przerywa sekwencję, a następna zaczyna się normalnie", () => {
    const parser = new OscParser();
    expect(parser.feed("\x1b]0;urwany\x1b[0m\x1b]2;cały\x07")).toEqual([{ code: "2", data: "cały" }]);
  });

  test("sekwencja bez średnika ma pusty napis danych", () => {
    expect(new OscParser().feed("\x1b]110\x07")).toEqual([{ code: "110", data: "" }]);
  });

  test("zbyt długa sekwencja jest pomijana w całości, a parser działa dalej", () => {
    const parser = new OscParser();
    expect(parser.feed(`\x1b]1337;File=${"x".repeat(10_000)}\x07`)).toEqual([]);
    expect(parser.feed("\x1b]9;4;1;50\x07")).toEqual([{ code: "9", data: "4;1;50" }]);
  });
});
