import { describe, expect, test } from "bun:test";
import { DesktopWorkBackups, desktopWorkBackupsText } from "../src/lib/desktop-work-backups.ts";

const NOW = new Date("2026-11-18T12:00:00.000Z");
const BASE = { folder: "/Users/me/Library/Application Support/trackwall/work-backups", files: 3, keep: 14, everyHours: 4 };

describe("the backups the desktop app downloads", () => {
  test("the shell's answer reads with each kind of last run", () => {
    const saved = { kind: "saved" as const, at: NOW.getTime() - 3_600_000, file: "trackwall-backup-2026-11-18-1100.tar.gz" };
    expect(DesktopWorkBackups.parse({ ...BASE, last: saved }).last).toEqual(saved);
    expect(DesktopWorkBackups.safeParse({ ...BASE, last: { kind: "other", at: 1 } }).success).toBe(false);
  });

  test("says where the backups go, how many there are and what the last run did", () => {
    expect(desktopWorkBackupsText({ ...BASE, last: null }, NOW)).toBe(
      "This app downloads a backup every 4 hours and keeps the newest 14 in /Users/me/Library/Application Support/trackwall/work-backups (3 now). The first one comes a few minutes after the app starts.",
    );
    const saved = { kind: "saved" as const, at: NOW.getTime() - 3_600_000, file: "trackwall-backup-2026-11-18-1100.tar.gz" };
    expect(desktopWorkBackupsText({ ...BASE, last: saved }, NOW)).toEndWith("Last saved 1 h ago: trackwall-backup-2026-11-18-1100.tar.gz.");
    const failed = { kind: "failed" as const, at: NOW.getTime() - 120_000, message: "the daemon did not answer in time" };
    expect(desktopWorkBackupsText({ ...BASE, last: failed }, NOW)).toEndWith(
      "The last try 2 min ago failed: the daemon did not answer in time",
    );
  });
});
