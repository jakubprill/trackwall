import { describe, expect, test } from "bun:test";
import { breadcrumbs, changesLabel, formatBytes, relativeTime, twoDigits } from "../src/lib/format.ts";

describe("format", () => {
  const now = new Date("2026-10-23T12:00:00Z");

  test("czas względny po angielsku, starsze daty jako data", () => {
    expect(relativeTime("2026-10-23T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-10-23T11:15:00Z", now)).toBe("45 min ago");
    expect(relativeTime("2026-10-23T09:00:00+00:00", now)).toBe("3 h ago");
    expect(relativeTime("2026-10-22T10:00:00Z", now)).toBe("yesterday");
    expect(relativeTime("2026-10-18T12:00:00Z", now)).toBe("5 days ago");
    expect(relativeTime("2026-03-10T12:00:00", now)).toBe("Mar 10, 2026");
  });

  test("liczba zmian z angielską liczbą mnogą, czyste repo bez etykiety", () => {
    expect([0, 1, 2, 5, 12, 22, 25].map(changesLabel)).toEqual([
      undefined,
      "1 change",
      "2 changes",
      "5 changes",
      "12 changes",
      "22 changes",
      "25 changes",
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

  test("liczba na liście ma co najmniej dwie cyfry", () => {
    expect([1, 12, 120].map(twoDigits)).toEqual(["01", "12", "120"]);
  });
});
