import { describe, expect, test } from "bun:test";
import type { TestFailure } from "@trackwall/protocol";
import { atLine, expectedActual, foldedTrace, traceLines } from "../src/lib/failed-test.ts";

const failure = (className: string | null, lines: string[]): TestFailure => ({
  report: "pricing/target/surefire-reports/TEST-shop.pricing.DiscountCalculatorTest.xml",
  suite: className ?? "cart.test.ts",
  className,
  name: "appliesPercentDiscountInEur",
  kind: "failure",
  type: "org.opentest4j.AssertionFailedError",
  message: null,
  lines,
  omittedLines: 0,
  timeSeconds: 0.04,
});

describe("the values an assertion compared", () => {
  test("JUnit 5 gives them in angle brackets, also after the assertion's own message", () => {
    expect(expectedActual("expected: <90.00> but was: <89.99>")).toEqual({ expected: "90.00", actual: "89.99" });
    expect(expectedActual("total in EUR ==> expected: <90.00> but was: <89.99>")).toEqual({ expected: "90.00", actual: "89.99" });
  });

  test("JUnit 4 and Spring's MockMvc give them without spaces", () => {
    expect(expectedActual("expected:<[Alice]> but was:<[Bob]>")).toEqual({ expected: "[Alice]", actual: "[Bob]" });
    expect(expectedActual("Status expected:<200> but was:<500>")).toEqual({ expected: "200", actual: "500" });
  });

  test("AssertJ gives them on lines of their own", () => {
    expect(expectedActual('\nexpected: "PAID"\n but was: "NEW"')).toEqual({ expected: '"PAID"', actual: '"NEW"' });
  });

  test("a value that holds an angle bracket itself stays whole", () => {
    expect(expectedActual("expected: <List<A>> but was: <List<B>>")).toEqual({ expected: "List<A>", actual: "List<B>" });
  });

  test("a message without both values, without a message, or with values too long to compare gives none", () => {
    expect(expectedActual("NULL not allowed for column CURRENCY")).toBeNull();
    expect(expectedActual(null)).toBeNull();
    expect(expectedActual(`expected: <${"x".repeat(201)}> but was: <y>`)).toBeNull();
  });
});

describe("the lines of a failed test's stack trace", () => {
  test("frames of the test's own packages open in the editor, those of libraries do not, and exceptions are told apart", () => {
    const lines = [
      "org.opentest4j.AssertionFailedError: expected: <90.00> but was: <89.99>",
      "\tat org.junit.jupiter.api.AssertionUtils.fail(AssertionUtils.java:151)",
      "\tat shop.pricing.DiscountCalculator.apply(DiscountCalculator.java:41)",
      "\tat shop.pricing.DiscountCalculatorTest.appliesPercentDiscountInEur(DiscountCalculatorTest.java:58)",
      "Caused by: java.lang.ArithmeticException: Rounding necessary",
      "\tat java.base/java.math.BigDecimal.setScale(BigDecimal.java:2952)",
      "\t... 64 more",
    ];

    expect(traceLines(failure("shop.pricing.DiscountCalculatorTest", lines)).map((line) => line.kind)).toEqual([
      "exception",
      "library",
      "own",
      "own",
      "exception",
      "library",
      "other",
    ]);
  });

  test("the own packages are the test class's first two package names", () => {
    const lines = [
      "java.lang.IllegalStateException: no rate",
      "\tat com.example.rates.RateClient.fetch(RateClient.java:20)",
      "\tat com.other.Lib.call(Lib.java:3)",
    ];

    expect(traceLines(failure("com.example.shop.CartTest", lines)).map((line) => line.kind)).toEqual(["exception", "own", "library"]);
  });

  test("a test without a package, or from a jest or Vitest report, has no own frames", () => {
    const lines = ["Error: boom", "\tat Cart.total(Cart.java:3)"];

    expect(traceLines(failure("CartTest", lines)).map((line) => line.kind)).toEqual(["exception", "library"]);
    expect(traceLines(failure(null, lines)).map((line) => line.kind)).toEqual(["exception", "library"]);
  });
});

describe("library frames folded in the trace", () => {
  const exception = { kind: "exception", text: "AssertionFailedError: expected: <3> but was: <4>" } as const;
  const lib = (n: number) => ({ kind: "library", text: `\tat org.junit.Lib.call${n}(Lib.java:${n})` }) as const;
  const own = { kind: "own", text: "\tat shop.CartTest.sums(CartTest.java:12)" } as const;

  test("a run of library frames keeps its first frame and folds the rest into one row", () => {
    expect(foldedTrace([exception, lib(1), lib(2), lib(3), own, lib(4), lib(5), lib(6), lib(7)])).toEqual([
      exception,
      lib(1),
      { kind: "folded", count: 2 },
      own,
      lib(4),
      { kind: "folded", count: 3 },
    ]);
  });

  test("one or two library frames in a row stay as they are", () => {
    expect(foldedTrace([exception, lib(1), own, lib(2), lib(3)])).toEqual([exception, lib(1), own, lib(2), lib(3)]);
  });
});

describe("the editor address of a frame's file", () => {
  test("goes to the frame's line, or to the file's top without one", () => {
    expect(atLine("vscode://file/w/Cart.java", 42)).toBe("vscode://file/w/Cart.java:42");
    expect(atLine("vscode://file/w/Cart.java", null)).toBe("vscode://file/w/Cart.java");
  });
});
