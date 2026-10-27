import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type ErrorJournal as ErrorJournalData, TrackwallError, type TrackwallErrorSource, type UiErrorReport } from "@trackwall/protocol";
import { z } from "zod";
import { writeFileAtomic } from "../../infra/atomic-write.ts";
import { messageOf } from "../../infra/errors.ts";
import { anonymize, compileKnownValues, type KnownValue, type KnownValues } from "./anonymize.ts";
import { type ErrorJournalWorkspace, systemValues, workspaceValues } from "./known-values.ts";
import { SHELL_ERRORS_FILE, shellFrame, takeShellErrors } from "./shell-errors.ts";
import { parseStack, repoPath, trackwallFrames } from "./stack-frames.ts";
import { uiFramePlace } from "./ui-source-map.ts";

/**
 * The `error-journal` module (ADR-94): Trackwall's own errors, so that one seen yesterday is still there today with where in
 * Trackwall's code it came from. The daemon's unexpected errors (an API action or MCP tool that failed with something other
 * than a `DomainError`, an exception nobody caught, a failed start), the UI's (sent by the UI) and the desktop shell's
 * (read from the shell's own file) go into one list, the same error counted once by its fingerprint. Every text is
 * anonymized before it is kept (`anonymize.ts`) and again when the journal is read, with what the workspace knows by then.
 * Nothing leaves the computer. The list is `logs/errors.json` in the state directory, at most `MAX_ERRORS` errors, written
 * at most once a second, and at once by `flush` before the daemon exits on an error.
 */

/** The file's name in the state directory's `logs/`. */
const ERROR_JOURNAL_FILE = "errors.json";
/** The most errors kept; the ones seen longest ago go first. */
const MAX_ERRORS = 100;
const WRITE_DELAY_MS = 1000;

const JournalFile = z.object({ errors: z.array(TrackwallError) });

export interface ErrorJournalDeps {
  /** The state directory's `logs/`, where the journal and the shell's file are. */
  dir: string;
  /** The state directory, Trackwall's own, whose paths stay readable. */
  stateDir: string;
  /** The folder the daemon serves the UI from, with the source maps of its chunks. */
  uiDir?: string;
  version: string;
  /** Absent for the journal of a start that failed before the workspace was read. */
  workspace?: ErrorJournalWorkspace;
  env: NodeJS.ProcessEnv;
  log: (msg: string) => void;
}

/** An error before it is counted: what `record` needs to find it in the list. */
interface Occurrence {
  source: TrackwallErrorSource;
  area: string;
  kind: string;
  message: string;
  frames: string[];
  at: string;
}

export class ErrorJournal {
  private readonly deps: ErrorJournalDeps;
  private readonly file: string;
  private readonly errors = new Map<string, TrackwallError>();
  /** The computer's values, read once: they do not change while the daemon runs. */
  private readonly systemKnown: KnownValue[];
  private known: KnownValues;
  private writeTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: ErrorJournalDeps) {
    this.deps = deps;
    this.file = join(deps.dir, ERROR_JOURNAL_FILE);
    this.systemKnown = systemValues(deps.stateDir, deps.env);
    this.known = compileKnownValues(this.systemKnown);
    for (const error of this.load()) this.errors.set(error.fingerprint, error);
    void this.refreshWorkspaceValues();
  }

  /** An unexpected error of the daemon in `area` (`api:/api/workspace/sync`, `mcp:get_repo`, `uncaught`, `startup`). */
  recordDaemonError(area: string, err: unknown): void {
    const frames = trackwallFrames(parseStack(err instanceof Error ? (err.stack ?? "") : ""), (frame) => {
      const path = repoPath(frame.file, "daemon");
      return path ? { path, line: frame.line } : null;
    });
    this.record({ source: "daemon", area, kind: errorKind(err), message: messageOf(err), frames, at: now() });
  }

  /** An error the UI caught; its area is the UI folder of its top frame (`ui:views/repos`), or the page without one. */
  recordUiError(report: UiErrorReport): void {
    const frames = trackwallFrames(parseStack(report.stack), (frame) => uiFramePlace(frame, this.deps.uiDir));
    const folder = frames[0] ? /^packages\/ui\/src\/(.+)\/[^/]+$/.exec(frames[0].replace(/:\d+$/, ""))?.[1] : undefined;
    const area = `ui:${folder ?? report.page}`;
    // The UI's error name is the page's text: only an identifier is kept.
    const kind = /^[A-Za-z_$][\w$]{0,60}$/.test(report.name) ? report.name : "Error";
    this.record({ source: "ui", area, kind, message: report.message, frames, at: now() });
  }

  /** The journal with the shell's new errors, newest first, every text anonymized again with what the workspace knows now. */
  async list(): Promise<ErrorJournalData> {
    await this.refreshWorkspaceValues();
    for (const line of takeShellErrors(join(this.deps.dir, SHELL_ERRORS_FILE))) {
      const frame = shellFrame(line.location);
      this.record({
        source: "shell",
        area: `shell:${line.area}`,
        kind: line.kind,
        message: line.message,
        frames: frame ? [frame] : [],
        at: new Date(line.atMs).toISOString(),
      });
    }
    return { errors: [...this.errors.values()].sort((a, b) => b.lastSeen.localeCompare(a.lastSeen)) };
  }

  clear(): void {
    this.errors.clear();
    takeShellErrors(join(this.deps.dir, SHELL_ERRORS_FILE));
    this.flush();
  }

  /** Writes the journal now: before the daemon exits on an error, which would not wait for the delayed write. */
  flush(): void {
    clearTimeout(this.writeTimer);
    this.writeTimer = undefined;
    try {
      this.anonymizeKept();
      mkdirSync(this.deps.dir, { recursive: true });
      writeFileAtomic(this.file, `${JSON.stringify({ errors: [...this.errors.values()] }, null, 2)}\n`);
    } catch (err) {
      this.deps.log(`failed to write the error journal: ${messageOf(err)}`);
    }
  }

  /** Never throws: the journal is called from the paths that handle errors, which must not get another one. */
  private record(o: Occurrence): void {
    try {
      this.count(o);
    } catch (err) {
      this.deps.log(`failed to record an error in the journal: ${messageOf(err)}`);
    }
  }

  private count(o: Occurrence): void {
    const message = anonymize(o.message, this.known);
    const fingerprint = errorFingerprint(o.source, o.area, o.kind, o.frames[0] ?? null, message);
    const seen = this.errors.get(fingerprint);
    this.errors.set(fingerprint, {
      fingerprint,
      source: o.source,
      area: o.area,
      kind: o.kind,
      message,
      frames: o.frames,
      count: (seen?.count ?? 0) + 1,
      firstSeen: seen && seen.firstSeen < o.at ? seen.firstSeen : o.at,
      lastSeen: seen && seen.lastSeen > o.at ? seen.lastSeen : o.at,
      version: this.deps.version,
    });
    this.prune();
    this.writeTimer ??= setTimeout(() => this.flush(), WRITE_DELAY_MS);
    this.writeTimer.unref?.();
  }

  /**
   * What the workspace knows, read now and kept for the errors before the next read (`record` cannot wait for it); the
   * messages kept so far are anonymized again with it.
   */
  private async refreshWorkspaceValues(): Promise<void> {
    if (!this.deps.workspace) return;
    this.known = compileKnownValues([...this.systemKnown, ...(await workspaceValues(this.deps.workspace))]);
    this.anonymizeKept();
  }

  /**
   * The kept errors again with what the workspace knows now: one recorded before it was read did not have its names yet.
   * Its fingerprint follows the new message, so its next occurrence counts on the same error; two that become one merge.
   */
  private anonymizeKept(): void {
    const kept = [...this.errors.values()];
    this.errors.clear();
    for (const error of kept) {
      const message = anonymize(error.message, this.known);
      const fingerprint = errorFingerprint(error.source, error.area, error.kind, error.frames[0] ?? null, message);
      const seen = this.errors.get(fingerprint);
      this.errors.set(fingerprint, {
        ...error,
        fingerprint,
        message,
        count: error.count + (seen?.count ?? 0),
        firstSeen: seen && seen.firstSeen < error.firstSeen ? seen.firstSeen : error.firstSeen,
        lastSeen: seen && seen.lastSeen > error.lastSeen ? seen.lastSeen : error.lastSeen,
      });
    }
  }

  private prune(): void {
    if (this.errors.size <= MAX_ERRORS) return;
    const oldest = [...this.errors.values()].sort((a, b) => a.lastSeen.localeCompare(b.lastSeen));
    for (const error of oldest.slice(0, this.errors.size - MAX_ERRORS)) this.errors.delete(error.fingerprint);
  }

  /** A journal that is missing or not the expected JSON starts empty; it holds nothing that cannot be seen again. */
  private load(): TrackwallError[] {
    try {
      const parsed = JournalFile.safeParse(JSON.parse(readFileSync(this.file, "utf8")));
      return parsed.success ? parsed.data.errors : [];
    } catch {
      return [];
    }
  }
}

/**
 * The same error twice has the same source, area, kind and top frame; without a frame its message stands in, with the numbers
 * in it (ports, counts, ids) and what anonymization put in left out, so "port 51234" and "port 51240" are one error, and so
 * are `<path>` and `<projects>/…` for one folder seen before and after the workspace was read.
 */
export function errorFingerprint(source: string, area: string, kind: string, topFrame: string | null, message: string): string {
  const key = [source, area, kind, topFrame ?? message.replace(/<[a-z]+>(?:\/…)?/g, "<>").replace(/\d+/g, "#")].join("\n");
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}

function errorKind(err: unknown): string {
  return err instanceof Error ? err.name || "Error" : "thrown";
}

function now(): string {
  return new Date().toISOString();
}
