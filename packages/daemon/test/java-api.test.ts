import { describe, expect, test } from "bun:test";
import { type ApiChangesVcs, apiChanges, type FileApi, librarySourceRoots, typeChanges } from "../src/modules/cards/api-changes.ts";
import { readJavaApi } from "../src/modules/cards/java-api.ts";
import { loadSyntaxParsers } from "../src/modules/cards/syntax-tree.ts";

const parsers = await loadSyntaxParsers();

function api(path: string, source: string): FileApi {
  const read = parsers.read("java", source, readJavaApi);
  if (read.kind !== "parsed") throw new Error(`not parsed: ${read.kind}`);
  return { path, types: read.value };
}

const MONEY = "money/src/main/java/com/example/money/Money.java";

const money = [
  "package com.example.money;",
  "",
  "public class Money<T extends Number> implements Comparable<Money<T>> {",
  '  public static final String CODE = "EUR";',
  "  protected long amount;",
  "  private int hidden;",
  "  int packagePrivate;",
  "  public Money(long amount) {}",
  "  private Money() {}",
  "  public List<String> split(int parts, String... names) { return null; }",
  "  public static Money<?> of(@Valid long value) { return null; }",
  "  public interface Rounding { int scale(); default int mode() { return 0; } private void step() {} }",
  "  public enum Currency { EUR, PLN }",
  "  private static class Cache { public void clear() {} }",
  "}",
  "class Helper { public void help() {} }",
].join("\n");

describe("the public API of a Java file (ADR-205)", () => {
  test("lists public types with nested ones by full name, and only the members another module sees, keyed by name and parameter types", () => {
    const types = api(MONEY, money).types.map((t) => ({ name: t.name, line: t.line, header: t.header, members: [...t.members] }));

    expect(types).toEqual([
      {
        name: "com.example.money.Money",
        line: 3,
        header: "class Money <T extends Number> implements Comparable<Money<T>>",
        members: [
          ["CODE", "static final CODE: String"],
          ["amount", "amount: long"],
          ["Money(long)", "Money(long)"],
          ["split(int, String...)", "split(int, String...): List<String>"],
          ["of(long)", "static of(long): Money<?>"],
        ],
      },
      {
        name: "com.example.money.Money.Rounding",
        line: 12,
        header: "interface Rounding",
        members: [
          ["scale()", "abstract scale(): int"],
          ["mode()", "mode(): int"],
        ],
      },
      {
        name: "com.example.money.Money.Currency",
        line: 13,
        header: "enum Currency",
        members: [
          ["EUR", "constant EUR"],
          ["PLN", "constant PLN"],
        ],
      },
    ]);
  });

  test("a record's components are part of its declaration", () => {
    const [record] = api(
      "Amount.java",
      "package p;\npublic record Amount(long value, String currency) { public String text() { return null; } }",
    ).types;

    expect(record?.header).toBe("record Amount (long value,String currency)");
    expect([...(record?.members.keys() ?? [])]).toEqual(["text()"]);
  });
});

describe("which public types a change breaks (ADR-205)", () => {
  test("code that only moved, a new member and a new type break nothing", () => {
    const after = money
      .replace("public class Money", "\n\npublic class Money")
      .replace("  private int hidden;", "  public Money plus(Money other) { return this; }\n  private long hidden;")
      .concat("\npublic class Rate {}");

    expect(typeChanges([api(MONEY, money)], [api(MONEY, after)])).toEqual([]);
  });

  test("a removed method, a changed return type and a new abstract method of an interface each name the member", () => {
    const after = money
      .replace("public static Money<?> of(@Valid long value)", "public static Money<?> of(long value, String currency)")
      .replace("public List<String> split", "public Set<String> split")
      .replace("int scale();", "int scale(); int precision();");

    expect(typeChanges([api(MONEY, money)], [api(MONEY, after)])).toEqual([
      {
        change: "changed",
        package: "com.example.money",
        type: "com.example.money.Money",
        declaration: false,
        members: ["split(int, String...)", "of(long)"],
        evidence: { path: MONEY, line: 3 },
      },
      {
        change: "changed",
        package: "com.example.money",
        type: "com.example.money.Money.Rounding",
        declaration: false,
        members: ["precision()"],
        evidence: { path: MONEY, line: 12 },
      },
    ]);
  });

  test("a type made package-private or moved to another package is removed, and a removed enum constant changes the enum", () => {
    const after = money.replace("public class Money", "class Money");
    expect(typeChanges([api(MONEY, money)], [api(MONEY, after)]).map((c) => [c.change, c.type])).toEqual([
      ["removed", "com.example.money.Money"],
      ["removed", "com.example.money.Money.Rounding"],
      ["removed", "com.example.money.Money.Currency"],
    ]);

    const fewer = money.replace("EUR, PLN", "EUR");
    expect(typeChanges([api(MONEY, money)], [api(MONEY, fewer)]).map((c) => [c.type, c.members])).toEqual([
      ["com.example.money.Money.Currency", ["PLN"]],
    ]);
  });

  test("a new supertype or type parameter changes the declaration", () => {
    const after = money.replace("implements Comparable<Money<T>>", "implements Comparable<Money<T>>, Serializable");

    expect(typeChanges([api(MONEY, money)], [api(MONEY, after)]).map((c) => [c.type, c.declaration, c.members])).toEqual([
      ["com.example.money.Money", true, []],
    ]);
  });

  test("types are paired across files, so a type moved to another file of the change is not removed", () => {
    const rate = "package com.example.money;\npublic class Rate { public long basis() { return 0; } }";
    const before = [api(MONEY, `${money}\n${rate.split("\n")[1]}`)];
    const after = [api(MONEY, money), api("money/src/main/java/com/example/money/Rate.java", rate)];

    expect(typeChanges(before, after)).toEqual([]);
  });

  test("the library sources are the src/main/java folder of every module that builds a Maven package", () => {
    const card = (paths: string[]) => ({
      provides: paths.map((path) => ({
        kind: "package" as const,
        ecosystem: "maven" as const,
        name: `com.example:${path}`,
        version: "1.0.0",
        evidence: { path, line: 3 },
      })),
    });

    expect(librarySourceRoots([card(["pom.xml", "money/pom.xml"]), card(["money/build.gradle.kts"])])).toEqual([
      "src/main/java/",
      "money/src/main/java/",
    ]);
  });

  test("a constructor added to a class without one takes away its implicit constructor without arguments", () => {
    const before = "package p;\npublic class Rate { public long basis() { return 0; } }";
    const after = "package p;\npublic class Rate { public Rate(long basis) {} public long basis() { return 0; } }";

    expect(typeChanges([api("Rate.java", before)], [api("Rate.java", after)]).map((c) => c.members)).toEqual([["Rate()"]]);
  });

  test("a new annotation element without a default breaks every use, one with a default does not", () => {
    const before = 'package p;\npublic @interface Audited { String value() default ""; }';
    const withDefault = before.replace("}", "int level() default 1; }");
    const required = before.replace("}", "int level(); }");

    expect(typeChanges([api("A.java", before)], [api("A.java", withDefault)])).toEqual([]);
    expect(typeChanges([api("A.java", before)], [api("A.java", required)]).map((c) => c.members)).toEqual([["level()"]]);
  });

  test("a class made final or sealed changes its declaration, and a nested class losing static becomes an inner one", () => {
    const before = "package p;\npublic class Shape { public static class Point {} }";
    const changes = (after: string) => typeChanges([api("S.java", before)], [api("S.java", after)]).map((c) => [c.type, c.declaration]);

    expect(changes(before.replace("public class Shape", "public final class Shape"))).toEqual([["p.Shape", true]]);
    expect(changes(before.replace("public static class Point", "public class Point"))).toEqual([["p.Shape.Point", true]]);
  });

  test("abstract written on an interface or final on a record restates its kind, and a default given to an element breaks nobody", () => {
    const before =
      "package p;\npublic interface Pricing { int scale(); }\npublic record Price(long cents) {}\npublic @interface Tag { String value(); }";
    const after = before
      .replace("public interface", "public abstract interface")
      .replace("public record", "public final record")
      .replace("String value();", 'String value() default "";')
      .replace("int scale();", "default int scale() { return 2; }");

    expect(typeChanges([api("P.java", before)], [api("P.java", after)])).toEqual([]);
  });

  test("a protected nested type counts, and an interface constant is the same with or without static final written", () => {
    const before = "package p;\npublic class Base { protected static class Hook {} public interface Limits { int MAX = 3; } }";
    const after = before.replace("protected static class Hook {}", "").replace("int MAX = 3;", "static final int MAX = 3;");

    expect(typeChanges([api("B.java", before)], [api("B.java", after)]).map((c) => [c.change, c.type])).toEqual([
      ["removed", "p.Base.Hook"],
    ]);
  });
});

describe("reading the changed library files of a task (ADR-205)", () => {
  const BASE = "a".repeat(40);
  const HEAD = "b".repeat(40);
  const RATE = "money/src/main/java/p/Rate.java";

  function vcs(files: Record<string, Record<string, string>>, truncated = false): { vcs: ApiChangesVcs; asked: string[][] } {
    const asked: string[][] = [];
    return {
      asked,
      vcs: {
        changedPathsBetween: async (_dir, _from, _to, _max, pathspecs) => {
          asked.push([...pathspecs]);
          return { paths: [MONEY, RATE], truncated };
        },
        readFiles: async (_dir, commit, paths) =>
          new Map(
            paths.flatMap((path) =>
              files[commit]?.[path] === undefined ? [] : [[path, Buffer.from(files[commit]?.[path] ?? "")] as const],
            ),
          ),
      },
    };
  }

  test("only the library sources' Java files are asked for, and a file with syntax errors on either side is left out of the comparison", async () => {
    const rate = "package p;\npublic class Rate { public long basis() { return 0; } }";
    const files = {
      [BASE]: { [MONEY]: money, [RATE]: rate },
      [HEAD]: {
        [MONEY]: money.replace("public Money(long amount) {}", "public Money(long amount {}"),
        [RATE]: "package p;\npublic class Rate {}",
      },
    };
    const { vcs: git, asked } = vcs(files);

    const read = await apiChanges(git, "/repo", { base: BASE, head: HEAD }, ["money/src/main/java/"], parsers);

    expect(asked).toEqual([["money/src/main/java/*.java"]]);
    expect(read.types.map((t) => [t.type, t.members])).toEqual([["p.Rate", ["basis()"]]]);
    expect(read.problems).toEqual([
      { code: "parse-incomplete", path: MONEY, message: "public types not read: syntax errors", commit: "head" },
    ]);
  });

  test("too many changed files and files over the read limit are named as not read", async () => {
    const { vcs: git } = vcs({}, true);

    const read = await apiChanges(git, "/repo", { base: BASE, head: HEAD }, ["money/src/main/java/"], parsers);

    expect(read.problems.map((p) => [p.code, p.path])).toEqual([
      ["files-not-read", ""],
      ["files-not-read", MONEY],
    ]);
  });

  test("a repo without library sources reads nothing", async () => {
    const { vcs: git, asked } = vcs({});
    expect(await apiChanges(git, "/repo", { base: BASE, head: HEAD }, [], parsers)).toEqual({ types: [], problems: [] });
    expect(asked).toEqual([]);
  });
});
