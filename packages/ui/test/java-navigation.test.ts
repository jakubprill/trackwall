import { describe, expect, test } from "bun:test";
import { javaNavigationOffer } from "../src/lib/java-navigation.ts";

const JAVA = [{ name: "java", reason: "build file pom.xml" }];
const TYPESCRIPT = [{ name: "typescript", reason: "typescript dependency in package.json" }];

describe("Java navigation on the New session form", () => {
  test("a repo tagged java gets it when the daemon can start the language server", () => {
    expect(javaNavigationOffer(JAVA, { problem: null })).toEqual({ kind: "ready" });
  });

  test("a repo without the java tag, or one whose tags or settings are still loading, does not show it", () => {
    expect(javaNavigationOffer(TYPESCRIPT, { problem: null })).toEqual({ kind: "hidden" });
    expect(javaNavigationOffer(undefined, { problem: null })).toEqual({ kind: "hidden" });
    expect(javaNavigationOffer(JAVA, undefined)).toEqual({ kind: "hidden" });
  });

  test("in a repo tagged java it shows what it still needs: the settings, or a fix the daemon names", () => {
    expect(javaNavigationOffer(JAVA, null)).toEqual({
      kind: "unavailable",
      reason: "Not set up yet: add javaNavigation to workspace.yaml, as the Java navigation page of the documentation shows.",
    });
    expect(javaNavigationOffer(JAVA, { problem: "no Java program at /opt/jdk/bin/java" })).toEqual({
      kind: "unavailable",
      reason: "Cannot start: no Java program at /opt/jdk/bin/java.",
    });
  });
});
