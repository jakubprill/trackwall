import { describe, expect, test } from "bun:test";
import { currentRun } from "../src/lib/background-run.ts";

type Run = { startedAt: string; finishedAt: string | null };

const before: Run = { startedAt: "2026-10-23T10:00:00Z", finishedAt: "2026-10-23T10:01:00Z" };
const started: Run = { startedAt: "2026-10-23T11:00:00Z", finishedAt: null };

describe("przebieg w tle w UI", () => {
  test("bez akcji widać to, co zwróciło odpytanie", () => {
    expect(currentRun(undefined, { data: before, loadNumber: 3 })).toBe(before);
    expect(currentRun(undefined, {})).toBeUndefined();
  });

  test("wynik akcji wygrywa z odpowiedzią na pytanie wysłane przed akcją, także taką, która przyszła po niej", () => {
    const acted = { run: started, afterLoad: 5 };
    expect(currentRun(acted, { data: before, loadNumber: 4 })).toBe(started);
    expect(currentRun(acted, { data: before, loadNumber: 5 })).toBe(started);
    expect(currentRun(acted, { data: null, loadNumber: 5 })).toBe(started);
  });

  test("pierwsza odpowiedź na pytanie wysłane po akcji zastępuje jej wynik, także pusta po restarcie daemona", () => {
    const acted = { run: started, afterLoad: 5 };
    const fresh: Run = { ...started, finishedAt: "2026-10-23T11:00:05Z" };
    expect(currentRun(acted, { data: fresh, loadNumber: 6 })).toBe(fresh);
    expect(currentRun(acted, { data: null, loadNumber: 6 })).toBeNull();
  });
});
