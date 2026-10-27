import { describe, expect, test } from "bun:test";
import {
  type AppUpdate,
  availableText,
  canCancel,
  downloadedFraction,
  dueAfterTurns,
  type Installing,
  installingText,
  inTurnText,
  nextUpdate,
  progressLabel,
  stallText,
  UpdateCheck,
  waitingText,
} from "../src/lib/updates.ts";

const available: AppUpdate = { state: "available", currentVersion: "0.3.0", version: "0.3.1" };
const installing: Installing = { state: "installing", version: "0.3.1", stage: { stage: "connecting" }, lastDataAt: 0 };
const MB = 1024 * 1024;

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

  test("an install starts by connecting, from the moment of the click", () => {
    expect(nextUpdate(available, { kind: "install-started", version: "0.3.1", at: 5000 })).toEqual({
      state: "installing",
      version: "0.3.1",
      stage: { stage: "connecting" },
      lastDataAt: 5000,
    });
  });

  test("the download remembers its first report and when the bytes last grew", () => {
    const first = nextUpdate(installing, { kind: "progress", progress: { stage: "downloading", downloaded: MB, total: 4 * MB }, at: 1000 });
    expect(first).toEqual({
      ...installing,
      stage: { stage: "downloading", downloaded: MB, total: 4 * MB },
      lastDataAt: 1000,
      firstData: { at: 1000, downloaded: MB },
    });
    const more = nextUpdate(first, { kind: "progress", progress: { stage: "downloading", downloaded: 3 * MB, total: 4 * MB }, at: 2000 });
    expect(more).toMatchObject({ lastDataAt: 2000, firstData: { at: 1000, downloaded: MB } });
    const same = nextUpdate(more, { kind: "progress", progress: { stage: "downloading", downloaded: 3 * MB, total: 4 * MB }, at: 9000 });
    expect(same).toMatchObject({ lastDataAt: 2000 });
  });

  test("each later stage replaces the download", () => {
    const verifying = nextUpdate(installing, { kind: "progress", progress: { stage: "verifying" }, at: 7000 });
    expect(verifying).toMatchObject({ stage: { stage: "verifying" }, lastDataAt: 7000 });
    expect(nextUpdate(verifying, { kind: "progress", progress: { stage: "restarting" }, at: 8000 })).toMatchObject({
      stage: { stage: "restarting" },
    });
  });

  test("a failed or cancelled install keeps its version, so that it can be tried again", () => {
    const progress = nextUpdate(installing, { kind: "progress", progress: { stage: "downloading", downloaded: 1, total: 2 }, at: 1 });
    expect(nextUpdate(progress, { kind: "install-failed", message: "The update was cancelled." })).toEqual({
      state: "install-failed",
      version: "0.3.1",
      message: "The update was cancelled.",
    });
    expect(nextUpdate(progress, { kind: "install-failed", message: "Download of Trackwall 0.3.1 failed" })).toEqual({
      state: "install-failed",
      version: "0.3.1",
      message: "Download of Trackwall 0.3.1 failed",
    });
  });

  test("progress outside an install is ignored", () => {
    expect(nextUpdate(available, { kind: "progress", progress: { stage: "verifying" }, at: 1 })).toEqual(available);
  });
});

describe("app update texts", () => {
  test("the offer names both versions and warns about the restart", () => {
    expect(availableText({ currentVersion: "0.3.0", version: "0.3.1" })).toBe(
      "Trackwall 0.3.1 is available (you have 0.3.0). Restarting stops running services and sessions.",
    );
  });

  test("each stage of the install has its own line", () => {
    expect(installingText(installing, 0)).toBe("Connecting to download Trackwall 0.3.1…");
    expect(installingText({ ...installing, stage: { stage: "verifying" } }, 0)).toBe("Checking the signature of Trackwall 0.3.1…");
    expect(installingText({ ...installing, stage: { stage: "installing" } }, 0)).toBe("Installing Trackwall 0.3.1…");
    expect(installingText({ ...installing, stage: { stage: "restarting" } }, 0)).toBe("Restarting into Trackwall 0.3.1…");
  });

  test("the download shows its size, share and, after a second, its speed, which a stall hides", () => {
    const downloading: Installing = {
      ...installing,
      stage: { stage: "downloading", downloaded: 12 * MB, total: 40 * MB },
      lastDataAt: 500,
      firstData: { at: 0, downloaded: 10 * MB },
    };
    expect(installingText(downloading, 0)).toBe("Downloading Trackwall 0.3.1: 12.0 MB of 40.0 MB (30%)");
    expect(installingText({ ...downloading, lastDataAt: 4000 }, 0)).toBe(
      "Downloading Trackwall 0.3.1: 12.0 MB of 40.0 MB (30%), 512.0 KB/s",
    );
    expect(installingText({ ...downloading, lastDataAt: 4000 }, 30_000)).toBe("Downloading Trackwall 0.3.1: 12.0 MB of 40.0 MB (30%)");
    expect(downloadedFraction({ downloaded: 12 * MB, total: 40 * MB })).toBe(0.3);
    expect(downloadedFraction({ downloaded: 12 * MB, total: null })).toBeUndefined();
  });

  test("a download silent for 20 s says so, and only the download can be cancelled", () => {
    const downloading: Installing = { ...installing, stage: { stage: "downloading", downloaded: MB, total: 40 * MB }, lastDataAt: 1000 };
    expect(stallText(downloading, 20_999)).toBeUndefined();
    expect(stallText(downloading, 26_000)).toBe(
      "No data for 25 s. A proxy or firewall may be holding the download back; you can cancel and try again later.",
    );
    expect(stallText(installing, 30_000)).toStartWith("No data for 30 s.");
    expect(canCancel(downloading)).toBe(true);
    const unpacking: Installing = { ...installing, stage: { stage: "installing" } };
    expect(canCancel(unpacking)).toBe(false);
    expect(stallText(unpacking, 60_000)).toBeUndefined();
  });

  test("without the total size the progress shows only what has been downloaded", () => {
    expect(progressLabel({ downloaded: 512, total: null })).toBe("512 B");
  });

  test("the shell's check result says which newer version is available, or null when this one is the latest", () => {
    expect(UpdateCheck.parse({ currentVersion: "0.3.0", available: "0.3.1" })).toEqual({ currentVersion: "0.3.0", available: "0.3.1" });
    expect(UpdateCheck.parse({ currentVersion: "0.3.1", available: null }).available).toBeNull();
  });
});

describe("an update that waits for the agents' turns (ADR-97)", () => {
  const waiting: AppUpdate = { state: "waiting", currentVersion: "0.3.0", version: "0.3.1" };

  test("the user puts an available update off until the turns end, and can take that back", () => {
    expect(nextUpdate(available, { kind: "wait-started" })).toEqual(waiting);
    expect(nextUpdate(waiting, { kind: "wait-cancelled" })).toEqual(available);
  });

  test("a periodic check keeps the waiting update, even when it finds a newer version", () => {
    expect(nextUpdate(waiting, { kind: "check-started" })).toEqual(waiting);
    expect(nextUpdate(waiting, { kind: "checked", result: { currentVersion: "0.3.0", available: "0.3.2" } })).toEqual(waiting);
    expect(nextUpdate(waiting, { kind: "check-failed", message: "offline" })).toEqual(waiting);
  });

  test("the update installs once no agent is in the middle of a turn, not before the session list has loaded", () => {
    expect(dueAfterTurns(waiting, 2)).toBeUndefined();
    expect(dueAfterTurns(waiting, undefined)).toBeUndefined();
    expect(dueAfterTurns(waiting, 0)).toBe("0.3.1");
    expect(dueAfterTurns(available, 0)).toBeUndefined();
    expect(nextUpdate(waiting, { kind: "install-started", version: "0.3.1", at: 5 })).toMatchObject({
      state: "installing",
      version: "0.3.1",
    });
  });

  test("the strip says how many agents are in a turn and what the waiting update waits for", () => {
    expect(inTurnText(1)).toBe("1 agent is in the middle of a turn, which the restart cuts off.");
    expect(inTurnText(2)).toBe("2 agents are in the middle of a turn, which the restart cuts off.");
    expect(waitingText({ version: "0.3.1" }, 1)).toBe("Trackwall 0.3.1 installs once 1 agent finishes its turn.");
    expect(waitingText({ version: "0.3.1" }, 3)).toBe("Trackwall 0.3.1 installs once 3 agents finish their turn.");
  });
});
