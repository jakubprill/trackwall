import { join } from "node:path";
import { SERVICE_RELEASE_MS, type StateDirSource } from "@trackwall/protocol";
import { downloadVerified } from "./infra/download.ts";
import { vscodeUrl } from "./infra/editor-url.ts";
import { DomainError, messageOf } from "./infra/errors.ts";
import { runProgram } from "./infra/run-program.ts";
import { extractTarGz } from "./infra/tar.ts";
import { ensureTrackwallDir } from "./infra/trackwall-dir.ts";
import {
  AGENT_QUEUES_FILE,
  Agents,
  type AgentsDeps,
  LAST_SUPERVISOR_FILE,
  LEGACY_WORKTREES_DIR,
  RESUMABLE_SESSIONS_FILE,
  TASKS_FILE,
} from "./modules/agents/agents.ts";
import { resolveCopilot } from "./modules/agents/copilot-command.ts";
import { Batch } from "./modules/batch/batch.ts";
import { Board } from "./modules/board/board.ts";
import { CardCache } from "./modules/cards/card-cache.ts";
import { Cards } from "./modules/cards/cards.ts";
import { ConfigFiles } from "./modules/config-files/config-files.ts";
import { DayStart } from "./modules/day-start/day-start.ts";
import { DayStartFile } from "./modules/day-start/day-start-file.ts";
import { trustedFolderOf, trustedFolders } from "./modules/doctor/copilot-trust.ts";
import { Doctor } from "./modules/doctor/doctor.ts";
import { ErrorJournal } from "./modules/error-journal/error-journal.ts";
import type { ErrorJournalWorkspace } from "./modules/error-journal/known-values.ts";
import { Graph } from "./modules/graph/graph.ts";
import { JavaNavigation } from "./modules/java-navigation/java-navigation.ts";
import { JDTLS_JAVA, JDTLS_RELEASE, type JdtlsRelease } from "./modules/java-navigation/jdtls-release.ts";
import { LocalConfig } from "./modules/local-config/local-config.ts";
import { Logs } from "./modules/logs/logs.ts";
import { MergeRequests } from "./modules/merge-requests/merge-requests.ts";
import { Mise } from "./modules/mise/mise.ts";
import { ProcessGroups } from "./modules/procs/process-groups.ts";
import { RuntimeFile } from "./modules/procs/runtime-file.ts";
import { Services } from "./modules/services/services.ts";
import { TestReports } from "./modules/test-results/test-reports.ts";
import { Hosting, type HostingClis } from "./modules/vcs/hosting.ts";
import { systemTempFolder, Vcs } from "./modules/vcs/vcs.ts";
import { VERIFICATIONS_FILE, Verifications } from "./modules/verification/verifications.ts";
import { RepoWatch } from "./modules/workspace/repo-watch.ts";
import { Workspace } from "./modules/workspace/workspace.ts";
import { WorkspaceFile } from "./modules/workspace/workspace-file.ts";
import { groupPlatform } from "./platform/group-platform.ts";
import { mountTable } from "./platform/mount-table.ts";
import { terminalPlatform } from "./platform/terminal.ts";

/**
 * The facade (§4): the daemon's modules assembled in one place. Dependencies between modules are visible only here;
 * a module declares what it needs (e.g. `WorkspaceVcs`), and the facade hands it another module.
 */
export interface Facade {
  workspace: Workspace;
  /** HEAD and refs of the repos in the projects folder, compared every second (ADR-63); `main.ts` starts it. */
  repoWatch: RepoWatch;
  cards: Cards;
  graph: Graph;
  /** The local config files of the repos, backed up into the local config store every few seconds (ADR-86); `main.ts` starts it. */
  localConfig: LocalConfig;
  mise: Mise;
  procs: ProcessGroups;
  logs: Logs;
  agents: Agents;
  batch: Batch;
  /** The user's board items in `.trackwall/board` of the projects folder (ADR-133). */
  board: Board;
  services: Services;
  testReports: TestReports;
  verifications: Verifications;
  /** A finished task's push, its repo host's merge request form, and the merge request with its pipeline (ADR-77). */
  mergeRequests: MergeRequests;
  /** "Start my day": sync, the day report, and a new supervisor that reads it (ADR-70). */
  dayStart: DayStart;
  /** Trackwall's own errors from the daemon, the shell and the UI, anonymized, on this computer only (ADR-94). */
  errorJournal: ErrorJournal;
  /** Checks of what Trackwall needs on this computer, each with what to do when it fails (ADR-101). */
  doctor: Doctor;
  /** Installs jdtls and its Java for tasks' Java navigation, from Settings (ADR-123). */
  javaNavigation: JavaNavigation;
  /** Every file and folder Trackwall reads or writes, with its state, and the keys of `workspace.yaml` (ADR-108). */
  configFiles: ConfigFiles;
  /**
   * Opens a link from a README in the system (ADR-35): an `http` or `https` address checked by the `ExternalLink` schema.
   * It belongs to no module, because it concerns neither a repo nor the daemon's state.
   */
  openLink: (url: string) => void;
  /**
   * Daemon exit, before `procs.stopAll`: what a restart is to bring back stays as it is now, the sessions to resume
   * (ADR-95), the agent queues and the verifications (ADR-115), so what the stop of the groups changes does not reach it.
   */
  keepForRestart: () => void;
}

export type { CopilotHookOutput } from "./modules/agents/copilot-hook-output.ts";
export type { CopilotHookEvent } from "./modules/agents/copilot-hook-record.ts";
export { HOSTING_CLIS } from "./modules/vcs/hosting.ts";

const WORKSPACE_FILE = "workspace.yaml";
const RUNTIME_FILE = "runtime.json";
const CARDS_DIR = "cards";
/** The bare repo the local config store is pushed from (ADR-127). */
const LOCAL_CONFIG_PUSH_DIR = "local-config-push";
const DAY_START_FILE = "day-start.json";
const LOGS_DIR = "logs";
/** The limit of one source JSONL file; with the previous file after rotation a source takes at most twice that. */
const LOG_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** Service readiness (ADR-45): checks twice a second, and five minutes for a start, because Gradle and Maven compile first. */
const SERVICE_TIMING = { intervalMs: 500, startupMs: 5 * 60 * 1000, settleMs: 500, releaseMs: SERVICE_RELEASE_MS };
/** The jdtls archive is about 50 MB; ten minutes is a slow line, four times its size is a server sending something else. */
const JDTLS_DOWNLOAD = { timeoutMs: 10 * 60 * 1000, maxBytes: 200 * 1024 * 1024 };
const JDTLS_UNPACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface FacadeOptions {
  /**
   * The daemon's state directory; it holds `workspace.yaml` (ADR-13), `runtime.json` (§4.1), `logs/` (§4.2) and repo cards
   * (`cards/`, ADR-25) and the last day start (`day-start.json`, ADR-70).
   */
  home: string;
  /** How the state directory was chosen: `--home`, `TRACKWALL_HOME` or the default (`resolveTrackwallHome`). */
  homeFrom: StateDirSource;
  openUrl: (url: string) => void;
  openFolder: (dir: string) => void;
  /** The `mise` program with arguments before the command (`["mise"]` in the daemon). */
  miseCommand: readonly string[];
  /** The Copilot CLI program with arguments before the session's arguments (`["copilot"]` in the daemon, a fake in tests). */
  copilotCommand: readonly string[];
  /** The daemon's version (`VERSION`), given to every Copilot CLI session. */
  version: string;
  /** Where the session plugin's hooks POST to: this daemon's hook route (`sessionHookRequest`, ADR-88). */
  sessionHook: AgentsDeps["sessionHook"];
  /** This daemon's MCP server over HTTP with a session's tokens (`sessionMcpRequest`, ADR-89), for every Copilot CLI session. */
  sessionMcpServer: AgentsDeps["sessionMcpServer"];
  /** `gh` and `glab` for the repo hosts (`HOSTING_CLIS` in the daemon, a fake in tests). */
  hostingClis: HostingClis;
  /** The environment of processes started for the user (`userEnv`). */
  userEnv: () => Promise<NodeJS.ProcessEnv>;
  /** Only for tests, which point the Java navigation install at a local archive; the daemon leaves it out for the pinned release (ADR-123). */
  jdtlsRelease?: JdtlsRelease;
  /** The folder the daemon serves the UI from: the error journal maps the UI's frames with its source maps (ADR-94). */
  uiDir?: string;
  log: (msg: string) => void;
}

/**
 * The error journal (ADR-94) of the state directory `home`. `createFacade` gives it the workspace and the UI folder; a start
 * that fails before the facade exists makes one without them, which still leaves its error for the next daemon to show.
 */
export function createErrorJournal(
  o: Pick<FacadeOptions, "home" | "version" | "uiDir" | "log"> & { workspace?: ErrorJournalWorkspace },
): ErrorJournal {
  return new ErrorJournal({
    dir: join(o.home, LOGS_DIR),
    stateDir: o.home,
    uiDir: o.uiDir,
    version: o.version,
    workspace: o.workspace,
    env: process.env,
    log: o.log,
  });
}

export function createFacade(o: FacadeOptions): Facade {
  // `workspace` is set right below, before any git command asks for the folder.
  const vcs: Vcs = new Vcs(() =>
    workspace.projectsDir().then(
      (projects: string) => ensureTrackwallDir(projects, "scratch"),
      () => systemTempFolder(),
    ),
  );
  const hosting = new Hosting(o.hostingClis);
  const openEditor = (dir: string) => o.openUrl(vscodeUrl(dir));
  const workspace = new Workspace({
    file: new WorkspaceFile(join(o.home, WORKSPACE_FILE)),
    vcs,
    hosting,
    openEditor,
    openFolder: o.openFolder,
    // `localConfig` needs `workspace`, so it is made below; a clone ends long after both exist.
    // A restore that fails is logged, not the clone's failure: the repo is cloned, and Restore stays in its mise tasks tab.
    afterClone: async (dir) => {
      try {
        const restored = await localConfig.restoreCloned(dir);
        if (restored.length > 0) o.log(`restored ${restored.join(", ")} from the local config store into ${dir}`);
      } catch (err) {
        o.log(`restoring local config into ${dir} failed: ${messageOf(err)}`);
      }
    },
  });
  workspace.useGitProgramFromFile();
  const logs = new Logs({ dir: join(o.home, LOGS_DIR), maxFileBytes: LOG_FILE_MAX_BYTES, log: o.log });
  const procs = new ProcessGroups({
    runtime: new RuntimeFile(join(o.home, RUNTIME_FILE)),
    logs,
    platform: groupPlatform(),
    terminals: terminalPlatform(),
    log: o.log,
  });
  const cache = new CardCache(join(o.home, CARDS_DIR), o.log);
  cache.prune().catch((err: unknown) => o.log(`failed to clean up cards: ${String(err)}`));
  const cards = new Cards({ vcs, repos: workspace, cache, log: o.log });
  // A new repo or one whose HEAD moved gets its card in the background, so the next graph does not wait for it (ADR-63).
  const repoWatch = new RepoWatch({ repos: workspace, vcs, onHeadMoved: (repos) => cards.warmUp(repos), log: o.log });
  const localConfig = new LocalConfig({ repos: workspace, vcs, log: o.log, pushDir: join(o.home, LOCAL_CONFIG_PUSH_DIR) });
  const board = new Board({ projectsDir: () => workspace.projectsDir() });
  const agents = new Agents({
    procs,
    repos: workspace,
    vcs,
    home: o.home,
    copilot: o.copilotCommand,
    version: o.version,
    env: o.userEnv,
    // `mise` needs `agents` for the task worktrees it trusts, so it is made below; a session starts only after both.
    miseEnv: (place) => mise.sessionEnv(place),
    sessionHook: o.sessionHook,
    sessionMcpServer: o.sessionMcpServer,
    openEditor,
    boardHas: (item) => board.has(item),
    onTaskRemoved: (task) => logs.removeTaskLogs(task),
    log: o.log,
  });
  // A removal that failed on a held file, or a crash before it, leaves an ended task's logs behind (ADR-59). An unreadable
  // task list was moved aside and may come back, so then nothing is removed.
  if (!agents.taskListLost()) logs.removeTaskLogsExcept(agents.sessions().tasks.map((t) => t.id));
  const mise: Mise = new Mise({
    procs,
    repos: workspace,
    tasks: agents,
    vcs,
    command: o.miseCommand,
    env: o.userEnv,
    onTrusted: (repo) => agents.miseTrusted({ repo, task: null }),
  });
  const batch = new Batch({ workspace, mise, log: o.log });
  const graph = new Graph({ cards, workspace });
  const taskPort = (repo: string, task: string) => agents.taskOfRepo(task, repo).port;
  const services = new Services({ mise, logs, graph, cards, taskPort, env: o.userEnv, log: o.log, ...SERVICE_TIMING });
  const testReports = new TestReports({ repos: workspace, tasks: agents, logs, env: o.userEnv });
  const verifications = new Verifications({
    tasks: agents,
    mise,
    testReports,
    logs,
    onVerdict: (verification) => agents.verificationFinished(verification),
    file: join(o.home, VERIFICATIONS_FILE),
    log: o.log,
  });
  const mergeRequests = new MergeRequests({
    tasks: agents,
    vcs,
    hosting,
    repoHosts: () => workspace.repoHosts(),
    openUrl: o.openUrl,
  });
  const dayStart = new DayStart({
    workspace,
    agents,
    vcs,
    file: new DayStartFile(join(o.home, DAY_START_FILE), o.log),
    log: o.log,
  });
  const errorJournal = createErrorJournal({ ...o, workspace });
  const javaNavigationReadiness = () => agents.startOptions().javaNavigation;
  const javaNavigation = new JavaNavigation({
    repos: workspace,
    readiness: javaNavigationReadiness,
    release: o.jdtlsRelease ?? JDTLS_RELEASE,
    java: JDTLS_JAVA,
    download: (url, file, sha256) => downloadVerified(url, file, { sha256, ...JDTLS_DOWNLOAD }),
    extract: async (archive, dir) => extractTarGz(archive, dir, { env: await o.userEnv(), timeoutMs: JDTLS_UNPACK_TIMEOUT_MS }),
    installTool: (spec, dir) => mise.installTool(spec, dir),
    log: o.log,
  });
  const doctor = new Doctor({
    env: o.userEnv,
    run: async (command, args, { env, timeoutMs }) =>
      (await runProgram(command, args, { label: `${command} ${args.join(" ")}`, env, timeoutMs })).stdout.toString("utf8"),
    gitVersion: (timeoutMs) => vcs.version(timeoutMs),
    signedIn: (host, timeoutMs) => hosting.signedIn(host, timeoutMs),
    resolveCopilot: (env) => resolveCopilot(o.copilotCommand, env),
    mise: o.miseCommand,
    // Not set yet is a state the doctor reports; a broken `workspace.yaml` is an error it shows as one.
    projectsDir: () =>
      workspace.projectsDir().catch((err: unknown) => {
        if (err instanceof DomainError && err.code === "bad_request") return null;
        throw err;
      }),
    repoHosts: () => workspace.repoHosts(),
    mountTable,
    workspaceFile: workspace.configFile(),
    workspaceKeys: () => workspace.workspaceKeys(),
    javaNavigation: javaNavigationReadiness,
    now: () => new Date(),
  });
  const configFiles = new ConfigFiles({
    stateDir: { path: o.home, from: o.homeFrom },
    statePaths: {
      "workspace-file": workspace.configFile(),
      "tasks-file": join(o.home, TASKS_FILE),
      "resumable-sessions-file": join(o.home, RESUMABLE_SESSIONS_FILE),
      "last-supervisor-file": join(o.home, LAST_SUPERVISOR_FILE),
      "agent-queues-file": join(o.home, AGENT_QUEUES_FILE),
      "verifications-file": join(o.home, VERIFICATIONS_FILE),
      "day-start-file": join(o.home, DAY_START_FILE),
      "cards-dir": join(o.home, CARDS_DIR),
      "logs-dir": join(o.home, LOGS_DIR),
      "local-config-push-repo": join(o.home, LOCAL_CONFIG_PUSH_DIR),
      "legacy-worktrees-dir": join(o.home, LEGACY_WORKTREES_DIR),
    },
    // A projects folder that is not set or cannot be read is a state the view shows, not an error of the whole list.
    projectsDir: () => workspace.projectsDir().catch(() => null),
    worktreesDir: () => workspace.worktreesDir().catch(() => null),
    workspaceKeys: () => workspace.workspaceKeys(),
    env: o.userEnv,
    copilotTrust: trustedFolders,
    trustedFolderOf,
    projectsMiseEnv: async () => {
      const env = await mise.sessionEnv({ repo: null, task: null });
      return { variables: Object.keys(env.vars), secrets: env.secretNames, problem: env.problem };
    },
    localConfigStore: () => localConfig.store(),
    openEditor: (path) => o.openUrl(vscodeUrl(path)),
    openFolder: o.openFolder,
  });
  return {
    workspace,
    repoWatch,
    cards,
    graph,
    localConfig,
    mise,
    procs,
    logs,
    batch,
    board,
    agents,
    services,
    testReports,
    verifications,
    mergeRequests,
    dayStart,
    errorJournal,
    doctor,
    javaNavigation,
    configFiles,
    openLink: o.openUrl,
    keepForRestart: () => {
      agents.keepRunningSessionsForResume();
      verifications.keepForRestart();
    },
  };
}
