import { describe, expect, test } from "bun:test";
import { chosenOptions, moreOptionsOpen } from "../src/lib/start-options.ts";

describe("the folded options of the New session form", () => {
  test("a plain start names no option, and its options stay folded", () => {
    const chosen = chosenOptions({
      approvals: "ask",
      model: "",
      javaNavigation: false,
      view: "terminal",
      planFirst: false,
      secondAttempt: null,
    });
    expect(chosen).toEqual([]);
    expect(moreOptionsOpen(undefined, chosen)).toBe(false);
  });

  test("every option that differs from a plain start is named, in the order of the pills", () => {
    const chosen = chosenOptions({
      approvals: "auto",
      model: " gpt-5.5 ",
      javaNavigation: true,
      view: "conversation",
      planFirst: true,
      secondAttempt: "",
    });
    expect(chosen.map((c) => c.text)).toEqual([
      "No approvals",
      "Model: gpt-5.5",
      "Java navigation",
      "Chat",
      "Plan first",
      "Second attempt",
    ]);
  });

  test("only giving up approvals is marked as risky", () => {
    const chosen = chosenOptions({ approvals: "auto", model: "gpt-5.5", view: "terminal" });
    expect(chosen).toEqual([
      { text: "No approvals", risky: true },
      { text: "Model: gpt-5.5", risky: false },
    ]);
  });

  test("an option the form does not offer at this start is not named", () => {
    expect(chosenOptions({ model: "", view: "terminal" })).toEqual([]);
  });

  test("a model remembered for the repo opens the options until the user folds them", () => {
    const chosen = chosenOptions({ model: "gpt-5.5", view: "terminal" });
    expect(moreOptionsOpen(undefined, chosen)).toBe(true);
    expect(moreOptionsOpen(false, chosen)).toBe(false);
  });

  test("options the user opened stay open with nothing chosen", () => {
    expect(moreOptionsOpen(true, [])).toBe(true);
  });
});
