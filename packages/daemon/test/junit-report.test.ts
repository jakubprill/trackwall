import { describe, expect, test } from "bun:test";
import { parseXml } from "../src/infra/xml.ts";
import { parseJunitReport } from "../src/modules/test-results/junit-report.ts";
import { trimStack } from "../src/modules/test-results/test-reports.ts";

describe("a JUnit XML report", () => {
  test("a Surefire report gives counts from its test cases and each failure with its type, message and stack", () => {
    const report = parseJunitReport(`<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="shop.OrderTest" tests="4" failures="1" errors="1" skipped="1" time="0.5">
  <properties><property name="java.version" value="21"/></properties>
  <testcase name="createsAnOrder" classname="shop.OrderTest" time="0.1"/>
  <testcase name="rejectsEmptyCart" classname="shop.OrderTest" time="0.2">
    <failure message="expected: <1> but was: <2>" type="org.opentest4j.AssertionFailedError"><![CDATA[org.opentest4j.AssertionFailedError: expected: <1> but was: <2>
	at shop.OrderTest.rejectsEmptyCart(OrderTest.java:31)
]]></failure>
    <system-out>log output</system-out>
  </testcase>
  <testcase name="loadsPrices" classname="shop.OrderTest" time="0.15">
    <error message="Connection refused" type="java.net.ConnectException">java.net.ConnectException: Connection refused</error>
  </testcase>
  <testcase name="later" classname="shop.OrderTest" time="0"><skipped/></testcase>
</testsuite>`);

    expect(report.counts).toEqual({ tests: 4, failures: 1, errors: 1, skipped: 1, timeSeconds: 0.45 });
    expect(report.failures).toEqual([
      {
        suite: "shop.OrderTest",
        className: "shop.OrderTest",
        name: "rejectsEmptyCart",
        kind: "failure",
        type: "org.opentest4j.AssertionFailedError",
        message: "expected: <1> but was: <2>",
        stack: "org.opentest4j.AssertionFailedError: expected: <1> but was: <2>\n\tat shop.OrderTest.rejectsEmptyCart(OrderTest.java:31)",
        timeSeconds: 0.2,
      },
      {
        suite: "shop.OrderTest",
        className: "shop.OrderTest",
        name: "loadsPrices",
        kind: "error",
        type: "java.net.ConnectException",
        message: "Connection refused",
        stack: "java.net.ConnectException: Connection refused",
        timeSeconds: 0.15,
      },
    ]);
  });

  test("suites nested in <testsuites> (jest-junit, Vitest) are all counted, with each case's own suite", () => {
    const report = parseJunitReport(`<testsuites name="jest tests">
  <testsuite name="cart"><testcase classname="cart adds" name="cart adds" time="0.01"/></testsuite>
  <testsuite name="price">
    <testcase classname="price rounds" name="price rounds" time="0.02"><failure message="nope">Error: nope</failure></testcase>
  </testsuite>
</testsuites>`);

    expect(report.counts).toMatchObject({ tests: 2, failures: 1, errors: 0, skipped: 0 });
    expect(report.failures.map((f) => [f.suite, f.name, f.type])).toEqual([["price", "price rounds", null]]);
  });

  test("test cases with the same title (test.each in jest) all count, so a failure among them is not hidden", () => {
    const report = parseJunitReport(`<testsuites><testsuite name="cart">
  <testcase classname="cart adds item" name="cart adds item"><failure>Error: expected 2</failure></testcase>
  <testcase classname="cart adds item" name="cart adds item"/>
</testsuite></testsuites>`);

    expect(report.counts).toMatchObject({ tests: 2, failures: 1 });
  });

  test("a file whose root is not a test suite is refused", () => {
    expect(() => parseJunitReport("<project><modelVersion>4.0.0</modelVersion></project>")).toThrow("not <testsuite>");
  });

  test("a time that is not a plain number is left out instead of counted wrong", () => {
    const report = parseJunitReport(`<testsuite name="s"><testcase name="a" time="0,5"/><testcase name="b" time="2"/></testsuite>`);
    expect(report.counts.timeSeconds).toBe(2);
  });
});

describe("a failure's stack trace for an agent", () => {
  test("cuts a line as long as a large assertion message", () => {
    const { lines } = trimStack(`AssertionError: expected ${"x".repeat(10_000)}\n\tat a.B.c(B.java:1)`);
    expect(lines[0]).toHaveLength(500);
    expect(lines[1]).toBe("\tat a.B.c(B.java:1)");
  });

  test("keeps its start and every Caused by with the frame after it", () => {
    const frames = Array.from({ length: 30 }, (_, i) => `\tat org.junit.Frame${i}.run(Frame.java:${i})`);
    const text = [
      "java.lang.IllegalStateException: Failed to load ApplicationContext",
      ...frames,
      "Caused by: java.sql.SQLException: Access denied for user 'shop'",
      "\tat com.mysql.Driver.connect(Driver.java:10)",
      "\tat com.mysql.Driver.open(Driver.java:20)",
    ].join("\n");

    const { lines, omittedLines } = trimStack(text);

    expect(lines).toEqual([
      "java.lang.IllegalStateException: Failed to load ApplicationContext",
      ...frames.slice(0, 11),
      "Caused by: java.sql.SQLException: Access denied for user 'shop'",
      "\tat com.mysql.Driver.connect(Driver.java:10)",
    ]);
    expect(omittedLines).toBe(20);
  });
});

describe("XML attributes", () => {
  test("are decoded, may hold > in quotes, and a missing one is never an inherited property", () => {
    const root = parseXml(`<a message="x > y &amp; z" type='t'><b/></a>`);
    expect(root.attributes.get("message")).toBe("x > y & z");
    expect(root.attributes.get("type")).toBe("t");
    expect(root.attributes.get("constructor")).toBeUndefined();
    expect(root.children.map((c) => c.name)).toEqual(["b"]);
  });
});
