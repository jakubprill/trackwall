import { describe, expect, test } from "bun:test";
import { PAGE_CODE_LIFETIME_MS, PageCodes } from "../src/api/page-codes.ts";

describe("one-time page codes (ADR-161)", () => {
  test("a code opens once, and a code nobody issued opens nothing", () => {
    const codes = new PageCodes();
    const code = codes.issue();
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(codes.take("A".repeat(43))).toBe(false);
    expect(codes.take(code)).toBe(true);
    expect(codes.take(code)).toBe(false);
  });

  test("a code opens nothing a minute after it was issued, as a copy in the browser's history does", () => {
    let now = 1_000;
    const codes = new PageCodes(() => now);
    const used = codes.issue();
    const late = codes.issue();
    now += PAGE_CODE_LIFETIME_MS - 1;
    expect(codes.take(used)).toBe(true);
    now += 1;
    expect(codes.take(late)).toBe(false);
  });

  test("past 32 open codes the oldest closes, so asking for codes cannot fill memory", () => {
    const codes = new PageCodes();
    const first = codes.issue();
    const second = codes.issue();
    for (let i = 0; i < 31; i++) codes.issue();
    expect(codes.take(first)).toBe(false);
    expect(codes.take(second)).toBe(true);
  });
});
