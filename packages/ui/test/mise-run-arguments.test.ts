import { describe, expect, test } from "bun:test";
import { parseRunArguments } from "../src/lib/mise-run-arguments.ts";

describe("mise task run arguments typed in the UI", () => {
  test("words separated by spaces are the arguments, and an empty field is none", () => {
    expect(parseRunArguments("  OrderServiceTest#creates  com.example.*Test ")).toEqual({
      ok: true,
      args: ["OrderServiceTest#creates", "com.example.*Test"],
    });
    expect(parseRunArguments("")).toEqual({ ok: true, args: [] });
  });

  test("a word a shell would treat specially is named with the reason", () => {
    expect(parseRunArguments("OrderTest $(id)")).toEqual({
      ok: false,
      error: '"$(id)": a mise task argument is 1 to 200 letters, digits or _ . , / = # * @ + -, and does not start with -',
    });
  });

  test("more than 8 arguments are refused", () => {
    expect(parseRunArguments("a b c d e f g h i").ok).toBe(false);
  });
});
