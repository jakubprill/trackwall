import { describe, expect, test } from "bun:test";
import { JOB_LOG_CHARS_MAX } from "@trackwall/protocol";
import { jobLogExcerpt } from "../src/modules/logs/job-log-excerpt.ts";

describe("the end of a CI job's log", () => {
  test("GitHub's timestamps, colours and overwritten progress go, and a short log is whole", () => {
    const raw = [
      "2026-11-04T10:00:01.1234567Z ##[group]Run mvn test",
      "2026-11-04T10:00:02.0000000Z Downloading 10%\r20%\r100%",
      "2026-11-04T10:00:03.0000000Z \x1b[1;31m[ERROR]\x1b[m Tests run: 3, Failures: 1",
      "",
    ].join("\n");

    expect(jobLogExcerpt(raw, [])).toEqual({
      text: ["##[group]Run mvn test", "100%", "[ERROR] Tests run: 3, Failures: 1"].join("\n"),
      truncated: false,
    });
  });

  test("GitLab's section markers go, and a line that only ended a section is left out", () => {
    const raw = [
      "\x1b[0Ksection_start:1730700000:step_script\r\x1b[0KExecuting step_script",
      "$ ./mvnw test",
      "\x1b[0Ksection_end:1730700042:step_script\r\x1b[0K",
      "ERROR: Job failed: exit code 1",
    ].join("\n");

    expect(jobLogExcerpt(raw, []).text).toBe(["Executing step_script", "$ ./mvnw test", "ERROR: Job failed: exit code 1"].join("\n"));
  });

  test("the secrets the daemon knows are masked, also where the log overwrote them", () => {
    expect(jobLogExcerpt("login with s3cret-token-1\nhalf s3cret-\rtoken-1 done", ["s3cret-token-1"]).text).toBe(
      "login with ***\ntoken-1 done",
    );
  });

  test("a long log keeps its last 150 lines", () => {
    const raw = Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join("\n");
    const excerpt = jobLogExcerpt(raw, []);

    expect(excerpt.truncated).toBe(true);
    expect(excerpt.text.split("\n")).toEqual(Array.from({ length: 150 }, (_, i) => `line ${i + 251}`));
  });

  test("long lines keep the excerpt within its characters, and one huge last line shows its end", () => {
    const wide = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(2000)).join("\n");
    const lines = jobLogExcerpt(wide, []).text.split("\n");
    expect(lines).toEqual(["5", "6", "7", "8", "9"].map((digit) => digit.repeat(2000)));

    const huge = jobLogExcerpt(`start\n${"x".repeat(JOB_LOG_CHARS_MAX)}END`, []);
    expect(huge).toEqual({ text: `${"x".repeat(JOB_LOG_CHARS_MAX - 3)}END`, truncated: true });
  });

  test("a log the daemon did not read to its end gives no excerpt, since its last lines are not the job's", () => {
    expect(jobLogExcerpt("the first megabytes", [], true)).toEqual({ text: "", truncated: true });
  });
});
