import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageReport } from "../src/modules/usage-report/usage-report.ts";

const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** A Copilot CLI home with a projects folder, and the report over it at `NOW`. */
function setUp(o: { knownProjectsDir?: (projects: string) => string } = {}) {
  const home = mkdtempSync(join(tmpdir(), "trackwall-copilot-home-"));
  const projects = mkdtempSync(join(tmpdir(), "trackwall-projects-"));
  const projectsDir = o.knownProjectsDir?.(projects) ?? projects;
  const report = new UsageReport({
    copilotHome: async () => home,
    places: async () => ({ tasks: [], repos: [], projectsDir, isTaskBranch: () => false }),
    now: () => NOW,
    log: () => {},
  });
  /** A conversation of the supervisor with these event log lines. */
  const conversation = (id: string, lines: string[]) => {
    const dir = join(home, "session-state", id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "workspace.yaml"), `cwd: ${JSON.stringify(projects)}\n`);
    writeFileSync(join(dir, "events.jsonl"), lines.map((l) => `${l}\n`).join(""));
    return join(dir, "events.jsonl");
  };
  return { home, projects, report, conversation };
}

/** A receipt of `inputTokens` at `at`, with Copilot CLI's identity `key` (`<conversation>:<sequence>`). */
function receipt(at: string | undefined, inputTokens: number, key?: string): string {
  const [source, sequence] = key?.split(":") ?? [];
  const accounting = source === undefined ? undefined : { sourceSessionId: source, sequence: Number(sequence) };
  return JSON.stringify({ type: "session.usage_record", timestamp: at, data: { usage: { inputTokens, outputTokens: 1, accounting } } });
}

describe("the weekly usage report over Copilot CLI's event logs (ADR-195)", () => {
  test("a receipt written again in the same log or in another counts once", async () => {
    const { report, conversation } = setUp();
    conversation("a", [receipt("2026-11-03T08:00:00Z", 100, "a:1"), receipt("2026-11-03T08:00:00Z", 100, "a:1")]);
    conversation("b", [receipt("2026-11-03T08:00:00Z", 100, "a:1"), receipt("2026-11-03T09:00:00Z", 5, "b:1")]);

    expect((await report.week(0)).total).toMatchObject({ modelCalls: 2, inputTokens: 105 });
  });

  test("a call counts in the week of its own time, the week's end not included, and a receipt without a time not at all", async () => {
    const { report, conversation } = setUp();
    const end = new Date(NOW).toISOString();
    const start = new Date(NOW - 7 * DAY_MS).toISOString();
    conversation("a", [
      receipt(start, 1, "a:1"),
      receipt(end, 10, "a:2"),
      receipt(undefined, 100, "a:3"),
      receipt("2026-11-04T11:59:59Z", 1000, "a:4"),
    ]);

    expect((await report.week(0)).total?.inputTokens).toBe(1001);
    expect((await report.week(1)).total).toBeNull();
  });

  test("a log that grew is read again, and a removed one no longer counts", async () => {
    const { report, conversation } = setUp();
    const log = conversation("a", [receipt("2026-11-03T08:00:00Z", 1, "a:1")]);
    conversation("b", [receipt("2026-11-03T08:00:00Z", 10, "b:1")]);
    expect((await report.week(0)).total?.inputTokens).toBe(11);

    appendFileSync(log, `${receipt("2026-11-03T09:00:00Z", 100, "a:2")}\n`);
    expect((await report.week(0)).total?.inputTokens).toBe(111);

    rmSync(log);
    expect((await report.week(0)).total?.inputTokens).toBe(10);
  });

  test.skipIf(process.platform === "win32")("an event log that is a FIFO is skipped, not read forever", async () => {
    const { home, report, conversation } = setUp();
    conversation("a", [receipt("2026-11-03T08:00:00Z", 1, "a:1")]);
    const dir = join(home, "session-state", "planted");
    mkdirSync(dir, { recursive: true });
    expect(spawnSync("mkfifo", [join(dir, "events.jsonl")]).status).toBe(0);

    expect((await report.week(0)).total?.inputTokens).toBe(1);
  });

  test.skipIf(process.platform === "win32")(
    "a projects folder reached through a link matches the real folder Copilot CLI recorded",
    async () => {
      const link = join(mkdtempSync(join(tmpdir(), "trackwall-link-")), "projects");
      const { report, conversation } = setUp({ knownProjectsDir: (projects) => (symlinkSync(projects, link), link) });
      conversation("a", [receipt("2026-11-03T08:00:00Z", 1, "a:1")]);

      expect((await report.week(0)).work.map((w) => w.kind)).toEqual(["supervisor"]);
    },
  );
});
