import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_FILES } from "../src/facade.ts";
import { keepStateAcrossVersions, STATE_BACKUPS_DIR, STATE_BACKUPS_KEPT, stateBackups } from "../src/infra/state-backup.ts";
import { readStateFile } from "../src/infra/state-file.ts";
import { TASKS_FILE } from "../src/modules/agents/agents.ts";
import { TASKS_FORMAT } from "../src/modules/agents/task-file.ts";
import { VERIFICATIONS_FILE } from "../src/modules/verification/verifications.ts";

// The state of one Trackwall version kept across a change of version (ADR-244): a copy before another version reads
// it, and that copy back when a newer version left files this one cannot read. The files are the real kept state files
// of `fixtures/state-files/1/`, read through the real formats.

const FIXTURES = join(import.meta.dir, "fixtures", "state-files", "1");

/** A state directory holding every kept state file, as a Trackwall of state format 1 left it. */
function homeWithState(): string {
  const home = mkdtempSync(join(tmpdir(), "trackwall-state-backup-"));
  for (const name of readdirSync(FIXTURES)) copyFileSync(join(FIXTURES, name), join(home, name));
  return home;
}

/** Starts the daemon's state handling in `version`, at the given minute, as `main.ts` does before the facade. */
function startIn(home: string, version: string, minute = 0, log: string[] = []): string[] {
  keepStateAcrossVersions({
    home,
    version,
    files: STATE_FILES,
    now: () => new Date(Date.UTC(2026, 10, 13, 12, minute)),
    log: (m) => log.push(m),
  });
  return log;
}

const text = (path: string) => readFileSync(path, "utf8");

describe("state backups across Trackwall versions (ADR-244)", () => {
  test("a first start on an empty state directory takes no backup", () => {
    const home = mkdtempSync(join(tmpdir(), "trackwall-state-backup-"));
    startIn(home, "0.5.25");
    expect(stateBackups(home)).toEqual([]);
  });

  test("an update copies every state file before the new version reads it", () => {
    const home = homeWithState();
    startIn(home, "0.5.25", 0);
    startIn(home, "0.5.26", 1);
    const [backup, first] = stateBackups(home);
    expect(backup).toMatchObject({ from: "0.5.25", to: "0.5.26", takenAt: "2026-11-13T12:01:00.000Z" });
    // The first start with backups does not know which Trackwall wrote the files before it.
    expect(first).toMatchObject({ from: null, to: "0.5.25" });
    for (const name of readdirSync(FIXTURES)) expect(text(join(backup?.path ?? "", name))).toBe(text(join(FIXTURES, name)));
  });

  test("starting the same version again takes no new backup", () => {
    const home = homeWithState();
    startIn(home, "0.5.25", 0);
    startIn(home, "0.5.25", 1);
    expect(stateBackups(home).length).toBe(1);
  });

  test("going back to an older version after a newer state format brings back the older version's tasks", () => {
    const home = homeWithState();
    const tasks = join(home, TASKS_FILE);
    const original = text(tasks);
    startIn(home, "1.0.0", 0);
    startIn(home, "1.1.0", 1);
    // 1.1.0 writes tasks.json in a format 1.0.0 does not know, and changes another file.
    const newer = `${JSON.stringify({ version: 99, tasks: [], renamed: true })}\n`;
    writeFileSync(tasks, newer);
    writeFileSync(join(home, VERIFICATIONS_FILE), `${JSON.stringify({ version: 1, verifications: {} })}\n`);

    // Without the way back, 1.0.0 sets the file aside and starts with no tasks.
    const withoutBackup = homeWithState();
    writeFileSync(join(withoutBackup, TASKS_FILE), newer);
    expect(readStateFile(join(withoutBackup, TASKS_FILE), TASKS_FORMAT, () => {})).toBeUndefined();

    const log = startIn(home, "1.0.0", 2);
    expect(text(tasks)).toBe(original);
    expect(text(join(home, VERIFICATIONS_FILE))).toBe(text(join(FIXTURES, VERIFICATIONS_FILE)));
    const problems: string[] = [];
    expect(readStateFile(tasks, TASKS_FORMAT, (problem) => problems.push(problem))?.tasks.length).toBeGreaterThan(0);
    expect(problems).toEqual([]);
    expect(log).toContain(
      `${TASKS_FILE} written by a newer Trackwall: the state files 1.0.0 left, as copied at 2026-11-13T12:01:00.000Z, are back`,
    );
    // What 1.1.0 left is in the backup taken on the way back, so going forward again loses nothing.
    const [wayBack] = stateBackups(home);
    expect(wayBack).toMatchObject({ from: "1.1.0", to: "1.0.0" });
    expect(text(join(wayBack?.path ?? "", TASKS_FILE))).toBe(newer);
  });

  test("going back puts back the files as they were, removing one that the older version did not have", () => {
    const home = homeWithState();
    const verifications = join(home, VERIFICATIONS_FILE);
    const tasks = join(home, TASKS_FILE);
    const original = text(tasks);
    rmSync(verifications);
    startIn(home, "1.0.0", 0);
    startIn(home, "1.1.0", 1);
    writeFileSync(tasks, `${JSON.stringify({ version: 99, tasks: [] })}\n`);
    writeFileSync(verifications, `${JSON.stringify({ version: 1, verifications: {} })}\n`);
    startIn(home, "1.0.0", 2);
    expect(text(tasks)).toBe(original);
    expect(existsSync(verifications)).toBe(false);
  });

  test("going back to an older version keeps the newer files when it reads them all", () => {
    const home = homeWithState();
    startIn(home, "1.0.0", 0);
    startIn(home, "1.1.0", 1);
    const changed = `${JSON.stringify({ version: 1, verifications: {} })}\n`;
    writeFileSync(join(home, VERIFICATIONS_FILE), changed);
    startIn(home, "1.0.0", 2);
    expect(text(join(home, VERIFICATIONS_FILE))).toBe(changed);
  });

  test("with no backup of the older version, its newer files stay to be set aside as before", () => {
    const home = homeWithState();
    startIn(home, "1.1.0", 0);
    const newer = `${JSON.stringify({ version: 99, tasks: [] })}\n`;
    writeFileSync(join(home, TASKS_FILE), newer);
    const log = startIn(home, "1.0.0", 1);
    expect(text(join(home, TASKS_FILE))).toBe(newer);
    expect(log).toContain(
      `${TASKS_FILE} written by a newer Trackwall, and no backup of 1.0.0's state to go back to; they will be set aside`,
    );
  });

  test(`only the ${STATE_BACKUPS_KEPT} newest backups are kept, and a backup cut short is removed`, () => {
    const home = homeWithState();
    const cutShort = join(home, STATE_BACKUPS_DIR, "2026-11-13T11-00-00-000Z");
    mkdirSync(cutShort, { recursive: true });
    for (let minute = 0; minute < STATE_BACKUPS_KEPT + 2; minute++) startIn(home, `1.0.${minute}`, minute);
    const backups = stateBackups(home);
    expect(backups.length).toBe(STATE_BACKUPS_KEPT);
    expect(backups[0]).toMatchObject({ to: `1.0.${STATE_BACKUPS_KEPT + 1}` });
    expect(existsSync(cutShort)).toBe(false);
  });
});
