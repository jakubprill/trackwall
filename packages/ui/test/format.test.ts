import { describe, expect, test } from "bun:test";
import { breadcrumbs, changesLabel, formatBytes, relativeTime, slotNumber } from "../src/lib/format.ts";

describe("format", () => {
  const now = new Date("2026-10-23T12:00:00Z");

  test("czas względny po polsku, starsze daty jako data", () => {
    expect(relativeTime("2026-10-23T11:59:30Z", now)).toBe("przed chwilą");
    expect(relativeTime("2026-10-23T11:15:00Z", now)).toBe("45 min temu");
    expect(relativeTime("2026-10-23T09:00:00+00:00", now)).toBe("3 h temu");
    expect(relativeTime("2026-10-22T10:00:00Z", now)).toBe("wczoraj");
    expect(relativeTime("2026-10-18T12:00:00Z", now)).toBe("5 dni temu");
  });

  test("liczba zmian z polską odmianą, czyste repo bez etykiety", () => {
    expect([0, 1, 2, 5, 12, 22, 25].map(changesLabel)).toEqual([
      undefined,
      "1 zmiana",
      "2 zmiany",
      "5 zmian",
      "12 zmian",
      "22 zmiany",
      "25 zmian",
    ]);
  });

  test("okruszki ścieżki w repo zaczynają się od korzenia", () => {
    expect(breadcrumbs("")).toEqual([{ name: "/", path: "" }]);
    expect(breadcrumbs("src/lib")).toEqual([
      { name: "/", path: "" },
      { name: "src", path: "src" },
      { name: "lib", path: "src/lib" },
    ]);
  });

  test("rozmiar pliku w B, KB i MB", () => {
    expect([512, 2048, 3 * 1024 * 1024].map(formatBytes)).toEqual(["512 B", "2.0 KB", "3.0 MB"]);
  });

  test("numer slotu ma co najmniej dwie cyfry", () => {
    expect([1, 12, 120].map(slotNumber)).toEqual(["01", "12", "120"]);
  });
});
