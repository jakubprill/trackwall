import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jdtlsStatus, readJdtlsLog } from "../src/modules/agents/jdtls-log.ts";

/** The local time of a `!SESSION` line, as Eclipse writes it. */
const STARTED = new Date(2026, 9, 29, 10, 0, 0, 0);
const SESSION = "!SESSION 2026-10-29 10:00:00.000 -----------------------------------------------";
const after = (minutes: number) => new Date(STARTED.getTime() + minutes * 60_000);

const START_LINES = [
  SESSION,
  "eclipse.buildId=unknown",
  "java.version=25",
  "",
  "!ENTRY org.eclipse.jdt.ls.core 1 0 2026-10-29 10:00:01.120",
  "!MESSAGE Initializing Java Language Server 1.63.0.202610191322",
  "",
  "!ENTRY org.eclipse.jdt.ls.core 1 0 2026-10-29 10:00:03.500",
  "!MESSAGE Importing Maven project(s)",
];

describe("how a task's jdtls is doing, from its log (ADR-124)", () => {
  test("before jdtls wrote its log it is starting", () => {
    expect(jdtlsStatus(null, after(0), null)).toEqual({ kind: "starting" });
  });

  test("a start without the end of its import is importing since the start, and stalled after the limit", () => {
    const log = START_LINES.join("\n");
    expect(jdtlsStatus(log, after(1), null)).toEqual({ kind: "importing", since: STARTED.toISOString() });
    expect(jdtlsStatus(log, after(6), null)).toEqual({ kind: "stalled", since: STARTED.toISOString() });
  });

  test("an initialized workspace without an error is ready", () => {
    const log = [
      ...START_LINES,
      "",
      "!ENTRY org.eclipse.jdt.ls.core 1 0 2026-10-29 10:00:52.000",
      "!MESSAGE Workspace initialized in 50880ms",
    ];
    expect(jdtlsStatus(log.join("\r\n"), after(60), null)).toEqual({ kind: "ready" });
  });

  test("an error during the import fails it with the error's message, even when jdtls says it initialized after it", () => {
    const log = [
      ...START_LINES,
      "",
      "!ENTRY org.eclipse.buildship.core 4 0 2026-10-29 10:00:40.000",
      "!MESSAGE Synchronize project petclinic failed due to an error connecting to the Gradle build.",
      "!STACK 1",
      "org.gradle.tooling.BuildException: Could not run build action using Gradle distribution",
      "",
      "!ENTRY org.eclipse.jdt.ls.core 1 0 2026-10-29 10:01:22.000",
      "!MESSAGE Workspace initialized in 80000ms",
    ];
    expect(jdtlsStatus(log.join("\n"), after(2), null)).toEqual({
      kind: "failed",
      message: "Synchronize project petclinic failed due to an error connecting to the Gradle build.",
    });
  });

  test("only jdtls's last start counts, so a resume that imported fine is ready after one that failed", () => {
    const failed = [...START_LINES, "!ENTRY org.eclipse.jdt.ls.core 4 0 2026-10-29 10:00:05.000", "!MESSAGE Initialization failed"];
    const resumed = [
      "!SESSION 2026-10-29 11:00:00.000 -----------------------------------------------",
      "!ENTRY org.eclipse.jdt.ls.core 1 0 2026-10-29 11:00:04.000",
      "!MESSAGE Workspace initialized in 3900ms",
    ];
    expect(jdtlsStatus([...failed, ...resumed].join("\n"), after(70), null)).toEqual({ kind: "ready" });
    expect(jdtlsStatus(failed.join("\n"), after(1), null)).toEqual({ kind: "failed", message: "Initialization failed" });
  });

  test("an error in a sub-entry counts, and an info or warning does not", () => {
    const log = [
      ...START_LINES,
      "!ENTRY org.eclipse.m2e.core 2 0 2026-10-29 10:00:10.000",
      "!MESSAGE Using the default settings",
      "!ENTRY org.eclipse.jdt.ls.core 4 0 2026-10-29 10:00:11.000",
      "!MESSAGE ",
      "!SUBENTRY 1 org.eclipse.m2e.core 4 0 2026-10-29 10:00:11.000",
      "!MESSAGE Could not resolve dependencies for project com.example:shop:jar:1.0",
    ];
    expect(jdtlsStatus(log.join("\n"), after(1), null)).toEqual({
      kind: "failed",
      message: "Could not resolve dependencies for project com.example:shop:jar:1.0",
    });
  });

  test("an error after the workspace initialized leaves it ready", () => {
    const log = [
      ...START_LINES,
      "!ENTRY org.eclipse.jdt.ls.core 1 0 2026-10-29 10:00:52.000",
      "!MESSAGE Workspace initialized in 50880ms",
      "!ENTRY org.eclipse.jdt.ls.core 4 0 2026-10-29 10:05:00.000",
      "!MESSAGE Error in calling delegate command handler",
    ];
    expect(jdtlsStatus(log.join("\n"), after(10), null)).toEqual({ kind: "ready" });
  });

  test("a log whose last start is older than the running session is the run before, so jdtls is still starting", () => {
    const ready = [
      ...START_LINES,
      "!ENTRY org.eclipse.jdt.ls.core 1 0 2026-10-29 10:00:52.000",
      "!MESSAGE Workspace initialized in 50880ms",
    ];
    expect(jdtlsStatus(ready.join("\n"), after(61), after(60))).toEqual({ kind: "starting" });
    expect(jdtlsStatus(ready.join("\n"), after(2), STARTED)).toEqual({ kind: "ready" });
  });

  test("the log is read from the data folder, and a folder or nothing in its place is no log", async () => {
    const data = mkdtempSync(join(tmpdir(), "trackwall-jdtls-data-"));
    expect(await readJdtlsLog(data)).toBeNull();
    const metadata = join(data, "workspace", ".metadata");
    mkdirSync(join(metadata, ".log"), { recursive: true });
    expect(await readJdtlsLog(data)).toBeNull();

    const other = mkdtempSync(join(tmpdir(), "trackwall-jdtls-data-"));
    mkdirSync(join(other, "workspace", ".metadata"), { recursive: true });
    writeFileSync(join(other, "workspace", ".metadata", ".log"), SESSION);
    expect(await readJdtlsLog(other)).toBe(SESSION);
  });
});
