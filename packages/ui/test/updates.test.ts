import { describe, expect, test } from "bun:test";
import { type AppUpdate, availableText, installingText, nextUpdate, progressLabel, UpdateCheck } from "../src/lib/updates.ts";

const available: AppUpdate = { state: "available", currentVersion: "0.3.0", version: "0.3.1" };
const installing: AppUpdate = { state: "installing", version: "0.3.1" };

describe("app update state", () => {
  test("a check that finds a newer version offers it", () => {
    const checking = nextUpdate({ state: "idle" }, { kind: "check-started" });
    expect(checking).toEqual({ state: "checking" });
    expect(nextUpdate(checking, { kind: "checked", result: { currentVersion: "0.3.0", available: "0.3.1" } })).toEqual(available);
  });

  test("a check that finds nothing newer says this version is the latest", () => {
    expect(nextUpdate({ state: "checking" }, { kind: "checked", result: { currentVersion: "0.3.1", available: null } })).toEqual({
      state: "latest",
      currentVersion: "0.3.1",
    });
  });

  test("a periodic check keeps the offer of an update already found, even when it fails offline", () => {
    const started = nextUpdate(available, { kind: "check-started" });
    expect(started).toEqual(available);
    expect(nextUpdate(started, { kind: "check-failed", message: "Update check failed: offline" })).toEqual(available);
  });

  test("a check that finds an even newer version replaces the offer", () => {
    expect(nextUpdate(available, { kind: "checked", result: { currentVersion: "0.3.0", available: "0.3.2" } })).toEqual({
      state: "available",
      currentVersion: "0.3.0",
      version: "0.3.2",
    });
  });

  test("a check changes nothing while an update is being installed", () => {
    expect(nextUpdate(installing, { kind: "check-started" })).toEqual(installing);
    expect(nextUpdate(installing, { kind: "checked", result: { currentVersion: "0.3.0", available: "0.3.2" } })).toEqual(installing);
    expect(nextUpdate(installing, { kind: "check-failed", message: "offline" })).toEqual(installing);
  });

  test("a failed check without a known update shows the error", () => {
    expect(nextUpdate({ state: "checking" }, { kind: "check-failed", message: "Update check failed: offline" })).toEqual({
      state: "check-failed",
      message: "Update check failed: offline",
    });
  });

  test("a failed install keeps its version, so that it can be tried again", () => {
    const progress = nextUpdate(installing, { kind: "progress", progress: { downloaded: 1, total: 2 } });
    expect(progress).toEqual({ state: "installing", version: "0.3.1", progress: { downloaded: 1, total: 2 } });
    expect(nextUpdate(progress, { kind: "install-failed", message: "Download of Trackwall 0.3.1 failed" })).toEqual({
      state: "install-failed",
      version: "0.3.1",
      message: "Download of Trackwall 0.3.1 failed",
    });
  });

  test("progress outside an install is ignored", () => {
    expect(nextUpdate(available, { kind: "progress", progress: { downloaded: 1, total: 2 } })).toEqual(available);
  });
});

describe("app update texts", () => {
  test("the offer names both versions and warns about the restart", () => {
    expect(availableText({ currentVersion: "0.3.0", version: "0.3.1" })).toBe(
      "Trackwall 0.3.1 is available (you have 0.3.0). Restarting stops running services and sessions.",
    );
  });

  test("the install shows the progress once the download has started", () => {
    expect(installingText({ version: "0.3.1" })).toBe("Installing Trackwall 0.3.1…");
    expect(installingText({ version: "0.3.1", progress: { downloaded: 12 * 1024 * 1024, total: 40 * 1024 * 1024 } })).toBe(
      "Installing Trackwall 0.3.1: 12.0 MB of 40.0 MB (30%)",
    );
  });

  test("without the total size the progress shows only what has been downloaded", () => {
    expect(progressLabel({ downloaded: 512, total: null })).toBe("512 B");
  });

  test("the shell's check result says which newer version is available, or null when this one is the latest", () => {
    expect(UpdateCheck.parse({ currentVersion: "0.3.0", available: "0.3.1" })).toEqual({ currentVersion: "0.3.0", available: "0.3.1" });
    expect(UpdateCheck.parse({ currentVersion: "0.3.1", available: null }).available).toBeNull();
  });
});
