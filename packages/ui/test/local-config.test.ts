import { describe, expect, test } from "bun:test";
import type { LocalConfigStore, RepoLocalConfig } from "@trackwall/protocol";
import {
  canIgnore,
  canRestore,
  hasLocalConfig,
  localConfigFileStatus,
  localConfigStoreLines,
  remoteToAllow,
} from "../src/lib/local-config.ts";

describe("a repo's local config files", () => {
  test("each state has its line, and a file git does not ignore is a warning", () => {
    expect(
      [
        { kind: "absent", file: "mise.local.toml" },
        { kind: "tracked", file: ".worktreeinclude" },
        { kind: "missing", file: "mise.local.toml" },
        { kind: "backed_up", file: "mise.local.toml", ignored: true },
        { kind: "backed_up", file: "mise.local.toml", ignored: false },
        { kind: "pending", file: "mise.local.toml", ignored: true },
        { kind: "pending", file: "mise.local.toml", ignored: false },
      ].map((state) => localConfigFileStatus(state as RepoLocalConfig["files"][number])),
    ).toEqual([
      { label: "not in this repo" },
      { label: "in the repo's commits, not backed up" },
      { tone: "warning", label: "only in the store" },
      { tone: "ok", label: "backed up" },
      { tone: "warning", label: "backed up, git does not ignore it" },
      { label: "backing up…" },
      { tone: "warning", label: "backing up…, git does not ignore it" },
    ]);
  });

  test("Restore is offered for a file only the store has, and Ignore for a backed-up file git does not ignore", () => {
    const newClone: RepoLocalConfig = {
      repo: "orders",
      files: [
        { kind: "missing", file: "mise.local.toml" },
        { kind: "absent", file: ".worktreeinclude" },
      ],
    };
    const unignored: RepoLocalConfig = {
      repo: "orders",
      files: [
        { kind: "backed_up", file: "mise.local.toml", ignored: false },
        { kind: "tracked", file: ".worktreeinclude" },
      ],
    };
    const nothing: RepoLocalConfig = {
      repo: "web",
      files: [
        { kind: "absent", file: "mise.local.toml" },
        { kind: "absent", file: ".worktreeinclude" },
      ],
    };

    expect([canRestore(newClone), canIgnore(newClone), hasLocalConfig(newClone)]).toEqual([true, false, true]);
    expect([canRestore(unignored), canIgnore(unignored), hasLocalConfig(unignored)]).toEqual([false, true, true]);
    expect([canRestore(nothing), canIgnore(nothing), hasLocalConfig(nothing)]).toEqual([false, false, false]);
  });
});

describe("the local config store in the settings", () => {
  const now = new Date("2026-10-26T15:00:00Z");
  const store: LocalConfigStore = {
    dir: "C:\\Users\\me\\Dev\\.trackwall\\local",
    lastBackup: { hash: "abc", subject: "Back up orders: mise.local.toml", author: "Trackwall", date: "2026-10-26T14:55:00Z" },
    pushesTo: null,
    remote: null,
    remoteAllowed: false,
    remoteProblem: null,
    push: { kind: "none" },
    problem: null,
  };
  const remote = "https://git.example.com/me/trackwall-local.git";

  test("the last backup and, without a remote, that the backups stay on this computer", () => {
    expect(localConfigStoreLines(store, now)).toEqual({
      backup: "Last backup 5 min ago: Back up orders: mise.local.toml",
      push: { text: "No remote: the backups stay on this computer." },
    });
    expect(localConfigStoreLines({ ...store, lastBackup: null }, now).backup).toBe("Nothing backed up yet.");
    expect(remoteToAllow(store)).toBe(null);
  });

  test("a remote nobody allowed is not pushed to, and is offered to allow, or says why it cannot be", () => {
    const unallowed = { ...store, remote };

    expect(localConfigStoreLines(unallowed, now).push).toEqual({
      tone: "warning",
      text: "Not pushed: the backups stay on this computer until you choose a remote to push to.",
    });
    expect(remoteToAllow(unallowed)).toEqual({ remote, problem: null });
    expect(remoteToAllow({ ...unallowed, remoteProblem: "origin has 2 addresses" })).toEqual({ remote, problem: "origin has 2 addresses" });
  });

  test("the store is pushed to the allowed address even when its remote changed, which is offered again", () => {
    const changed = {
      ...store,
      pushesTo: remote,
      remote: "https://elsewhere.example/x.git",
      push: { kind: "ok", at: "2026-10-26T14:59:30Z" },
    } as const;

    expect(localConfigStoreLines(changed, now).push).toEqual({ tone: "ok", text: `Pushed to ${remote} just now.` });
    expect(remoteToAllow(changed)).toEqual({ remote: "https://elsewhere.example/x.git", problem: null });
    expect(remoteToAllow({ ...changed, remote, remoteAllowed: true })).toBe(null);
  });

  test("with an allowed remote, the next push, the last one or why it failed", () => {
    const allowed = { ...store, pushesTo: remote, remote, remoteAllowed: true };
    expect(localConfigStoreLines(allowed, now).push).toEqual({ text: `Pushes to ${remote} after the next backup.` });
    expect(
      localConfigStoreLines({ ...allowed, push: { kind: "failed", at: "2026-10-26T14:59:30Z", message: "rejected" } }, now).push,
    ).toEqual({
      tone: "error",
      text: `Push to ${remote} failed: rejected`,
    });
  });
});
