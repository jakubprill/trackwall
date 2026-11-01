import { describe, expect, test } from "bun:test";
import { javaMajors } from "../src/modules/java-navigation/java-majors.ts";

describe("the Java versions to install for the repos' builds (ADR-167)", () => {
  test("build file hints and mise tool versions become major versions, each once, in order", () => {
    expect(javaMajors(["21", "1.8", "17", "temurin-17", "corretto-21.0.4", " 11 ", "21.0.2", "temurin-jre-25"])).toEqual([
      8, 11, 17, 21, 25,
    ]);
  });

  test("what names no version and versions before 8 are left out", () => {
    expect(javaMajors(["latest", "$" + "{java.version}", "1.7", "6", ""])).toEqual([]);
  });
});
