import type { DayReport, DayStartRun, DayStartSettings, Session, SessionList, SyncRun } from "@trackwall/protocol";
import { messageOf } from "../../infra/errors.ts";
import { dayReport, type ReportVcs } from "./day-report.ts";
import type { DayStartFile } from "./day-start-file.ts";
import { dayStartFirstMessage } from "./first-message.ts";

/**
 * The `day-start` module (ADR-70, §4.11): "Start my day" syncs every repo, computes the day report against the last
 * day start, saves it, and starts a new supervisor whose first message asks for a briefing from that report. The
 * daemon computes, the supervisor judges: the report is one tool call instead of one per repo. One day start runs at a
 * time and lives in memory like a sync; only its report and the commits it compared are kept (`day-start.json`).
 */

/** What the day start needs from `workspace`: the repos, their sync awaited to the end, and the user's prompt. */
interface DayStartWorkspace {
  /** `bad_request` while the projects folder is not set. */
  projectsDir(): Promise<string>;
  /** The repos of the projects folder: identifier and root. */
  repoEntries(): Promise<{ id: string; path: string }[]>;
  syncAndWait(): Promise<SyncRun>;
  /** `invalid_config` for a bad `dayStart` key. */
  dayStartSettings(): DayStartSettings | null;
}

/** What the day start needs from `agents`: the open tasks and sessions, and a new supervisor with a first message. */
interface DayStartAgents {
  sessions(): SessionList;
  /** `bad_request` while a supervisor starts or runs. */
  assertNoSupervisor(): void;
  startSupervisorWith(firstMessage: string): Promise<Session>;
}

export interface DayStartDeps {
  workspace: DayStartWorkspace;
  agents: DayStartAgents;
  vcs: ReportVcs;
  file: DayStartFile;
  log: (msg: string) => void;
}

export class DayStart {
  readonly #deps: DayStartDeps;
  #run: DayStartRun | undefined;

  constructor(deps: DayStartDeps) {
    this.#deps = deps;
  }

  /**
   * Starts a day start in the background, or returns the running one. Refused before anything runs while a supervisor
   * runs, the projects folder is not set or `dayStart` in `workspace.yaml` is invalid, so the button says why at once.
   */
  async start(): Promise<DayStartRun> {
    if (this.#run?.finishedAt === null) return { ...this.#run };
    this.#deps.agents.assertNoSupervisor();
    const settings = this.#deps.workspace.dayStartSettings();
    await this.#deps.workspace.projectsDir();
    // Checked again after the `await`: a second click may have started one meanwhile.
    if (this.#run?.finishedAt === null) return { ...this.#run };
    const run: DayStartRun = { startedAt: new Date().toISOString(), finishedAt: null, step: "sync", error: null, supervisor: null };
    this.#run = run;
    void this.#steps(run, settings?.prompt ?? null)
      .catch((err: unknown) => {
        run.error = messageOf(err);
        this.#deps.log(`day start: ${run.step}: ${run.error}`);
      })
      .finally(() => {
        run.finishedAt = new Date().toISOString();
      });
    return { ...run };
  }

  /** The last day start since the daemon started; `null` when there was none. */
  run(): DayStartRun | null {
    return this.#run ? { ...this.#run } : null;
  }

  /** The report of the last day start, also one from before a restart; `null` before the first. */
  report(): DayReport | null {
    return this.#deps.file.read()?.report ?? null;
  }

  async #steps(run: DayStartRun, userPrompt: string | null): Promise<void> {
    const sync = await this.#deps.workspace.syncAndWait();
    run.step = "report";
    const repos = await this.#deps.workspace.repoEntries();
    const { sessions, tasks } = this.#deps.agents.sessions();
    const previous = this.#deps.file.read();
    const input = { startedAt: run.startedAt, previous, repos, sync, tasks, sessions };
    const { report, heads } = await dayReport(this.#deps.vcs, input, this.#deps.log);
    this.#deps.file.write({ startedAt: run.startedAt, heads, report });
    run.step = "supervisor";
    run.supervisor = (await this.#deps.agents.startSupervisorWith(dayStartFirstMessage(userPrompt))).id;
  }
}
