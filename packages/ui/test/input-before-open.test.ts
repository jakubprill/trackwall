import { describe, expect, test } from "bun:test";
import { InputBeforeOpen, MAX_HELD_INPUT } from "../src/lib/input-before-open.ts";

describe("keys typed before the session terminal connects", () => {
  test("wait until the first connection opens and then go to the session in the order they were typed", () => {
    const input = new InputBeforeOpen();

    expect(input.take("run the")).toBe("held");
    expect(input.take(" tests\r")).toBe("held");

    expect(input.open()).toEqual({ keys: ["run the", " tests\r"], dropped: false });
    expect(input.take("1")).toBe("send");
  });

  test("a reconnect gives none of them again", () => {
    const input = new InputBeforeOpen();
    input.take("1");
    input.open();

    expect(input.open()).toEqual({ keys: [], dropped: false });
  });

  test("keys beyond the limit are dropped, and so is every key after them, so no Enter goes without its text", () => {
    const input = new InputBeforeOpen();

    expect(input.take("a".repeat(MAX_HELD_INPUT - 1))).toBe("held");
    expect(input.take("bc")).toBe("dropped");
    expect(input.take("\r")).toBe("dropped");

    expect(input.open()).toEqual({ keys: ["a".repeat(MAX_HELD_INPUT - 1)], dropped: true });
  });

  test("when the first attempt to connect fails, the held keys are dropped and later keys are not held", () => {
    const input = new InputBeforeOpen();
    input.take("y\r");

    expect(input.fail()).toBe(true);
    expect(input.take("n")).toBe("send");
    expect(input.open()).toEqual({ keys: [], dropped: false });
  });

  test("a failed first attempt with nothing typed loses nothing", () => {
    expect(new InputBeforeOpen().fail()).toBe(false);
  });
});
