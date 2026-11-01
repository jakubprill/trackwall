import { describe, expect, test } from "bun:test";
import type { Session } from "@trackwall/protocol";
import {
  asksSessionJavaNavigation,
  javaNavigationInView,
  javaNavigationMark,
  javaNavigationOffer,
  javaNavigationPollMs,
  javaNavigationSetup,
} from "../src/lib/java-navigation.ts";

const JAVA = [{ name: "java", reason: "build file pom.xml" }];
const TYPESCRIPT = [{ name: "typescript", reason: "typescript dependency in package.json" }];

describe("Java navigation on the New session form", () => {
  test("a task in the conversation view cannot have it yet, and the pill says how to get it back", () => {
    expect(javaNavigationInView({ kind: "ready" }, "conversation")).toEqual({
      kind: "unavailable",
      reason: "Needs the terminal for now: turn Chat off to use it.",
    });
    expect(javaNavigationInView({ kind: "ready" }, "terminal")).toEqual({ kind: "ready" });
    expect(javaNavigationInView({ kind: "hidden" }, "conversation")).toEqual({ kind: "hidden" });
    // Turning Chat off would not set it up, so the reason it has stays.
    const notSetUp = { kind: "unavailable" as const, reason: "Not set up yet: install it in Settings › Agents." };
    expect(javaNavigationInView(notSetUp, "conversation")).toEqual(notSetUp);
  });

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
  const install = { jdtls: "1.63.0", java: "temurin-25", lombok: "1.18.48", step: null, error: null, warning: null, readiness: null };

  test("says what is missing and offers to install", () => {
    expect(javaNavigationSetup(install)).toEqual({ line: "Not set up yet.", tone: "muted", button: "Install" });
  });

  test("shows the step of a running install", () => {
    expect(javaNavigationSetup({ ...install, step: "Downloading jdtls 1.63.0" }).line).toBe("Downloading jdtls 1.63.0…");
  });

  test("names why the last install failed while tasks cannot get it, and not after a fix by hand", () => {
    expect(javaNavigationSetup({ ...install, error: "mise ERROR offline", readiness: { problem: "no Java program at /x/java" } })).toEqual({
      line: "The install failed: mise ERROR offline",
      tone: "error",
      button: "Install again",
    });
    expect(javaNavigationSetup({ ...install, error: "mise ERROR offline", readiness: { problem: null } }).tone).toBe("ok");
  });

  test("says whether tasks can get it with the settings in place", () => {
    expect(javaNavigationSetup({ ...install, readiness: { problem: null } })).toEqual({
      line: "Ready: tasks and sessions in Java repos can get it on the New session form.",
      tone: "ok",
      button: "Install again",
    });
    expect(javaNavigationSetup({ ...install, readiness: { problem: "no Java program at /x/java" } }).line).toBe(
      "Cannot start: no Java program at /x/java.",
    );
  });

  test("names the projects' Java versions an install that worked could not install", () => {
    expect(javaNavigationSetup({ ...install, warning: "mise could not install Java 8: no build", readiness: { problem: null } })).toEqual({
      line: "Ready, but mise could not install Java 8: no build. Projects that build with that Java will not import until its folder is in javaNavigation.runtimes in workspace.yaml.",
      tone: "warning",
      button: "Install again",
    });
  });
});

describe("the Java navigation mark of a running task", () => {
  test("is muted while jdtls starts and imports, and asks again often", () => {
    expect(javaNavigationMark({ kind: "starting" }).label).toBe("Java starting");
    expect(javaNavigationMark({ kind: "starting" }).tone).toBeUndefined();
    expect(javaNavigationMark({ kind: "importing", since: "2026-10-29T10:00:00.000Z" })).toMatchObject({ label: "Java importing" });
    expect(javaNavigationPollMs({ kind: "importing", since: "2026-10-29T10:00:00.000Z" })).toBe(3000);
  });

  test("warns when the import stalls, names jdtls's error when it failed, and is ok when ready", () => {
    expect(javaNavigationMark({ kind: "stalled", since: "2026-10-29T10:00:00.000Z" })).toMatchObject({ tone: "warning" });
    expect(javaNavigationMark({ kind: "failed", message: "Initialization failed" })).toEqual({
      label: "Java import failed",
      tone: "error",
      title: "jdtls could not import the project, so the agent's lsp tool answers with nothing: Initialization failed",
    });
    expect(javaNavigationMark({ kind: "ready" })).toMatchObject({ label: "Java ready", tone: "ok" });
    expect(javaNavigationPollMs({ kind: "ready" })).toBe(30_000);
  });
});

describe("the Java navigation mark of a running session (ADR-175)", () => {
  const main: Session = {
    id: "s1",
    repo: "shop",
    supervisor: false,
    startedAt: "2026-11-01T10:00:00Z",
    run: { kind: "running", runId: "s1", startedAt: "2026-11-01T10:00:00Z", pid: 1 },
    state: null,
    windowTitle: null,
    needsAttention: false,
    stuck: null,
    task: null,
    dialog: null,
    environment: { variables: [], secrets: [], agentSecrets: [], profile: null, problem: null },
    view: "terminal",
    readRequest: null,
  };

  test("a running main session in a terminal asks how its jdtls is doing", () => {
    expect(asksSessionJavaNavigation(main, true)).toBe(true);
  });

  test("an ended one, a free session, a task's session and one in the conversation view do not ask", () => {
    expect(asksSessionJavaNavigation(main, false)).toBe(false);
    expect(asksSessionJavaNavigation({ ...main, repo: null }, true)).toBe(false);
    expect(asksSessionJavaNavigation({ ...main, task: "t1" }, true)).toBe(false);
    expect(asksSessionJavaNavigation({ ...main, view: "conversation" }, true)).toBe(false);
  });
});
