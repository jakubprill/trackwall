import { describe, expect, test } from "bun:test";
import { LOG_BUFFER_RECORDS, LogLevel, type LogRecord } from "@trackwall/protocol";
import { logLevelClass, mergeTail, startsRun } from "../src/lib/log-tail.ts";

function record(seq: number, runId = "r1"): LogRecord {
  return { seq, ts: "2026-10-23T10:00:00Z", runId, stream: "stdout", level: "info", msg: `linia ${seq}` };
}

describe("log taska mise w UI", () => {
  test("nowa strona dokleja się na końcu, a dropped zaczyna listę od nowa", () => {
    const shown = [record(1), record(2)];

    expect(mergeTail(shown, { records: [record(5)], nextSeq: 5, dropped: false }).map((r) => r.seq)).toEqual([1, 2, 5]);
    expect(mergeTail(shown, { records: [record(9)], nextSeq: 9, dropped: true }).map((r) => r.seq)).toEqual([9]);
  });

  test("strona bez nowych rekordów zostawia tę samą listę, żeby widok nie malował wszystkich linii od nowa", () => {
    const shown = [record(1)];

    expect(mergeTail(shown, { records: [], nextSeq: 1, dropped: false })).toBe(shown);
  });

  test("lista nie jest dłuższa niż bufor źródła w daemonie", () => {
    const shown = Array.from({ length: LOG_BUFFER_RECORDS }, (_, i) => record(i + 1));
    const merged = mergeTail(shown, { records: [record(LOG_BUFFER_RECORDS + 1)], nextSeq: LOG_BUFFER_RECORDS + 1, dropped: false });

    expect(merged).toHaveLength(LOG_BUFFER_RECORDS);
    expect(merged.at(-1)?.seq).toBe(LOG_BUFFER_RECORDS + 1);
  });

  test("separator stoi przed pierwszym rekordem kolejnego uruchomienia, nie przed pierwszym w liście", () => {
    const records = [record(1, "a"), record(2, "a"), record(3, "b")];

    expect(records.map((_, i) => startsRun(records, i))).toEqual([false, false, true]);
  });

  test("kolor mają tylko błędy i ostrzeżenia, szczegóły są przygaszone", () => {
    expect(LogLevel.options.map(logLevelClass)).toEqual([
      "text-muted-foreground",
      "text-muted-foreground",
      "",
      "text-warning",
      "text-destructive",
    ]);
  });
});
