import { describe, expect, test } from "bun:test";
import { javaNavigationOffer, javaNavigationSetup } from "../src/lib/java-navigation.ts";

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
      reason: "Not set up yet: install it in Settings › Agents.",
    });
    expect(javaNavigationOffer(JAVA, { problem: "no Java program at /opt/jdk/bin/java" })).toEqual({
      kind: "unavailable",
      reason: "Cannot start: no Java program at /opt/jdk/bin/java.",
    });
  });
});

describe("the Java navigation section of Settings", () => {
  const install = { jdtls: "1.63.0", java: "temurin-25", running: false, step: null, error: null, readiness: null };

  test("says what is missing and offers to install", () => {
    expect(javaNavigationSetup(install)).toEqual({ line: "Not set up yet.", tone: "muted", button: "Install" });
  });

  test("shows the step of a running install", () => {
    expect(javaNavigationSetup({ ...install, running: true, step: "Downloading jdtls 1.63.0" }).line).toBe("Downloading jdtls 1.63.0…");
  });

  test("names why the last install failed before anything else", () => {
    expect(javaNavigationSetup({ ...install, error: "mise ERROR offline", readiness: { problem: null } })).toEqual({
      line: "The install failed: mise ERROR offline",
      tone: "error",
      button: "Install again",
    });
  });

  test("says whether tasks can get it with the settings in place", () => {
    expect(javaNavigationSetup({ ...install, readiness: { problem: null } })).toEqual({
      line: "Ready: tasks in Java repos can get it on the New session form.",
      tone: "ok",
      button: "Install again",
    });
    expect(javaNavigationSetup({ ...install, readiness: { problem: "no Java program at /x/java" } }).line).toBe(
      "Cannot start: no Java program at /x/java.",
    );
  });
});
