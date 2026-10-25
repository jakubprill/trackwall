import { describe, expect, test } from "bun:test";
import { LOG_BUFFER_RECORDS, LogLevel, type LogRecord } from "@trackwall/protocol";
import { logLevelClass, mergeTail, startsRun } from "../src/lib/log-tail.ts";

function record(seq: number, runId = "r1"): LogRecord {
  return { seq, ts: "2026-10-23T10:00:00Z", runId, stream: "stdout", level: "info", msg: `linia ${seq}` };
}

describe("mise task log in the UI", () => {
  test("a new page is appended at the end, and dropped starts the list again", () => {
    const shown = [record(1), record(2)];

    expect(mergeTail(shown, { records: [record(5)], nextSeq: 5, dropped: false }).map((r) => r.seq)).toEqual([1, 2, 5]);
    expect(mergeTail(shown, { records: [record(9)], nextSeq: 9, dropped: true }).map((r) => r.seq)).toEqual([9]);
  });

  test("a page without new records keeps the same list so the view does not repaint every line", () => {
    const shown = [record(1)];

    expect(mergeTail(shown, { records: [], nextSeq: 1, dropped: false })).toBe(shown);
  });

  test("the list is no longer than the source buffer in the daemon", () => {
    const shown = Array.from({ length: LOG_BUFFER_RECORDS }, (_, i) => record(i + 1));
    const merged = mergeTail(shown, { records: [record(LOG_BUFFER_RECORDS + 1)], nextSeq: LOG_BUFFER_RECORDS + 1, dropped: false });

    expect(merged).toHaveLength(LOG_BUFFER_RECORDS);
    expect(merged.at(-1)?.seq).toBe(LOG_BUFFER_RECORDS + 1);
  });

  test("the separator stands before the first record of the next run, not before the first in the list", () => {
    const records = [record(1, "a"), record(2, "a"), record(3, "b")];

    expect(records.map((_, i) => startsRun(records, i))).toEqual([false, false, true]);
  });

  test("only errors and warnings have a colour, details are dimmed", () => {
    const levels: LogLevel[] = ["error", "warn", "info", "debug", "trace"];
    expect(levels.toSorted()).toEqual([...LogLevel.options].toSorted());

    expect(levels.map(logLevelClass)).toEqual(["text-destructive", "text-warning", "", "text-muted-foreground", "text-muted-foreground"]);
  });
});
