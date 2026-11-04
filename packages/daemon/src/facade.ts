import { homedir } from "node:os";
import { join } from "node:path";
import {
  type AppConfig,
  type MiseTarget,
  type RoutineDigest,
  type RoutineName,
  SERVICE_RELEASE_MS,
  type SessionView,
  type StateDirSource,
  type Task,
  type TaskChangedEndpoints,
  type TaskOutcome,
  type TerminalPlace,
} from "@trackwall/protocol";
import { copilotHome } from "./infra/copilot-home.ts";
import { downloadVerified } from "./infra/download.ts";
import { vscodeUrl } from "./infra/editor-url.ts";
import { DomainError, messageOf } from "./infra/errors.ts";
import { runProgram } from "./infra/run-program.ts";
import { extractTarGz } from "./infra/tar.ts";
import { ensureTrackwallDir } from "./infra/trackwall-dir.ts";
import { userShell } from "./infra/user-shell.ts";
import {
  AGENT_QUEUES_FILE,
  Agents,
  type AgentsDeps,
  AUTO_REVIEWS_FILE,
  LAST_SUPERVISOR_FILE,
  LEGACY_WORKTREES_DIR,
  RESUMABLE_SESSIONS_FILE,
  TASK_ROUNDS_FILE,
  TASKS_FILE,
} from "./modules/agents/agents.ts";
import { resolveCopilot } from "./modules/agents/copilot-command.ts";
import { withMiseVars } from "./modules/agents/session-env.ts";
import { TaskBranch, taskWorktree } from "./modules/agents/task-branch.ts";
import { Batch } from "./modules/batch/batch.ts";
import { Board } from "./modules/board/board.ts";
import type { AppConfigQuery } from "./modules/cards/app-config.ts";
import { CardCache } from "./modules/cards/card-cache.ts";
import { Cards } from "./modules/cards/cards.ts";
import { ConfigFiles } from "./modules/config-files/config-files.ts";
import { DayStart } from "./modules/day-start/day-start.ts";
import { DayStartFile } from "./modules/day-start/day-start-file.ts";
import { trustedFolderOf, trustedFolders } from "./modules/doctor/copilot-trust.ts";
import { type DiskSpace, diskSpace } from "./modules/doctor/disk-space.ts";
import { Doctor } from "./modules/doctor/doctor.ts";
import { profileEnvironment } from "./modules/doctor/model-provider-check.ts";
import { SYSTEM_CA_FILES, sessionCertificates } from "./modules/doctor/network-check.ts";
import { probeConnection, probeTls, type TlsProbe } from "./modules/doctor/tls-probe.ts";
import { ErrorJournal } from "./modules/error-journal/error-journal.ts";
import type { ErrorJournalWorkspace } from "./modules/error-journal/known-values.ts";
import { Graph } from "./modules/graph/graph.ts";
import { JavaNavigation } from "./modules/java-navigation/java-navigation.ts";
import { JDTLS_JAVA, JDTLS_RELEASE, LOMBOK_RELEASE, type PinnedRelease } from "./modules/java-navigation/pinned-releases.ts";
import { Knowledge } from "./modules/knowledge/knowledge.ts";
import { LocalConfig } from "./modules/local-config/local-config.ts";
import { Logs } from "./modules/logs/logs.ts";
import { McpAudit } from "./modules/mcp-audit/mcp-audit.ts";
import { MergeRequests } from "./modules/merge-requests/merge-requests.ts";
import { Mise } from "./modules/mise/mise.ts";
import { ProcessGroups } from "./modules/procs/process-groups.ts";
import { RuntimeFile } from "./modules/procs/runtime-file.ts";
import { ProviderModels } from "./modules/provider-models/provider-models.ts";
import { Routines } from "./modules/routines/routines.ts";
import { Services } from "./modules/services/services.ts";
import { TASK_JOURNAL_FILE, TASK_JOURNAL_MAX_RECORDS, TaskJournal } from "./modules/task-journal/task-journal.ts";
import { FolderFiles } from "./modules/terminals/folder-files.ts";
import { FolderTerminals } from "./modules/terminals/folder-terminals.ts";
import { TestReports } from "./modules/test-results/test-reports.ts";
import { UsageReport } from "./modules/usage-report/usage-report.ts";
import type { KnownPlaces } from "./modules/usage-report/work-place.ts";
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
  /** Saved tasks the user runs by hand, in `.trackwall/routines` of the projects folder, with their approvals (ADR-173). */
  routines: Routines;
  /** Short facts about the user's repos in `.trackwall/knowledge` of the projects folder, with their approvals (ADR-170). */
  knowledge: Knowledge;
  services: Services;
  /** The user's own shells in the projects folder, a repo root or a task's worktree, shown like session terminals (ADR-185). */
  terminals: FolderTerminals;
  /** The files of the projects folder, a repo root or a task's worktree, read only, next to its Shell tab (ADR-188). */
  folderFiles: FolderFiles;
  testReports: TestReports;
  verifications: Verifications;
  /** What ended tasks were and left, searched by `search_task_history` (ADR-150). */
  taskJournal: TaskJournal;
  /** A finished task's push, its repo host's merge request form, and the merge request with its pipeline (ADR-77). */
  mergeRequests: MergeRequests;
  /** "Start my day": sync, the day report, and a new supervisor that reads it (ADR-70). */
  dayStart: DayStart;
  /** Trackwall's own errors from the daemon, the shell and the UI, anonymized, on this computer only (ADR-94). */
  errorJournal: ErrorJournal;
  /** Every MCP tool call the daemon answered, with its caller, identifier arguments and outcome, on this computer only (ADR-152). */
  mcpAudit: McpAudit;
  /** What Copilot CLI used in a week, by work and by tool, from its own event logs (ADR-199). */
  usageReport: UsageReport;
  /** Checks of what Trackwall needs on this computer, each with what to do when it fails (ADR-101). */
  doctor: Doctor;
  /** The models the session profile's model provider offers, which the Model fields suggest (ADR-194). */
  providerModels: ProviderModels;
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
   * The endpoints a task's commits change and the repos they reach (ADR-145, ADR-147), for `get_changed_endpoints` and
   * a task's Impact tab: the task from `agents`, its change and callers from `graph`.
   */
  taskChangedEndpoints: (task: string) => Promise<TaskChangedEndpoints>;
  /**
   * A task from a routine the user approved in the version they saw (ADR-173): the routine from `routines`, the task
   * from `agents`, with the routine's title, repo, model and approvals mode.
   */
  runRoutine: (name: RoutineName, digest: RoutineDigest, view: SessionView) => Promise<Task>;
  /**
   * The Spring configuration of a repo root or a task's worktree in one profile's view (ADR-153), for `get_app_config`:
   * the place from `workspace` or `agents`, the environment of a run there from `mise`, its masking from `logs`, the files and the view from `cards`.
   */
  appConfig: (request: AppConfigRequest) => Promise<AppConfig>;
  /**
   * What every task's work came to (ADR-154): its last verification's verdict from `verification` and its merge request
   * from `merge-requests`, for the Sessions list and the notification of a failed pipeline. A read from memory.
   */
  taskOutcomes: () => TaskOutcome[];
  /**
   * Daemon exit, before `procs.stopAll`: what a restart is to bring back stays as it is now, the sessions to resume
   * (ADR-95), the agent queues and the verifications (ADR-115), so what the stop of the groups changes does not reach it.
   */
  keepForRestart: () => void;
}

/** Where to read the configuration (a task of `repo` when `task` is set), the profile, and an optional key prefix. */
type AppConfigRequest = MiseTarget & AppConfigQuery;

export type { CopilotHookOutput } from "./modules/agents/copilot-hook-output.ts";
export type { CopilotHookEvent } from "./modules/agents/copilot-hook-record.ts";
export type { FileDownload } from "./modules/terminals/folder-files.ts";
export { HOSTING_CLIS } from "./modules/vcs/hosting.ts";

const WORKSPACE_FILE = "workspace.yaml";
const RUNTIME_FILE = "runtime.json";
const CARDS_DIR = "cards";
/** The bare repo the local config store is pushed from (ADR-127). */
const LOCAL_CONFIG_PUSH_DIR = "local-config-push";
const DAY_START_FILE = "day-start.json";
const ROUTINE_APPROVALS_FILE = "routine-approvals.json";
const KNOWLEDGE_APPROVALS_FILE = "knowledge-approvals.json";
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
  /** The daemon runs in a container (`CONTAINER_MARKERS`), so the repos live in its volume (ADR-162). */
  inContainer: boolean;
  /** The `mise` program with arguments before the command (`["mise"]` in the daemon). */
  miseCommand: readonly string[];
  /** The Copilot CLI program with arguments before the session's arguments (`["copilot"]` in the daemon, a fake in tests). */
  copilotCommand: readonly string[];
  /** The daemon's version (`VERSION`), given to every Copilot CLI session. */
  version: string;
  /** Where the session plugin's hooks POST to: this daemon's hook route (`sessionHookRequest`, ADR-88). */
  sessionHook: AgentsDeps["sessionHook"];
  /** This daemon's MCP server over HTTP with a session's token (`sessionMcpRequest`, ADR-89, ADR-138), for every Copilot CLI session. */
  sessionMcpServer: AgentsDeps["sessionMcpServer"];
  /** `gh` and `glab` for the repo hosts (`HOSTING_CLIS` in the daemon, a fake in tests). */
  hostingClis: HostingClis;
  /** The environment of processes started for the user (`userEnv`). */
  userEnv: () => Promise<NodeJS.ProcessEnv>;
  /** Only for tests, which point the Java navigation install at a local archive; the daemon leaves it out for the pinned release (ADR-123). */
  jdtlsRelease?: PinnedRelease;
  /** Only for tests, like `jdtlsRelease`; the daemon leaves it out for the pinned Lombok jar (ADR-167). */
  lombokRelease?: PinnedRelease;
  /** Only for tests, which keep the doctor's network check off the network; the daemon leaves it out for `probeTls` (ADR-166). */
  tlsProbe?: TlsProbe;
  /** Only for tests, like `tlsProbe`; the daemon leaves it out for `probeConnection` (ADR-179). */
  connectionProbe?: TlsProbe;
  /** Only for tests, like `tlsProbe`, so that the doctor's report does not depend on the runner's disk; the daemon leaves it out for `diskSpace`. */
  diskSpace?: (folder: string) => Promise<DiskSpace>;
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
  const openEditor = (path: string, line?: number) => o.openUrl(vscodeUrl(path, line));
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
    inContainer: o.inContainer,
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
  const routines = new Routines({
    projectsDir: () => workspace.projectsDir(),
    approvalsFile: join(o.home, ROUTINE_APPROVALS_FILE),
    log: o.log,
  });
  const knowledge = new Knowledge({
    projectsDir: () => workspace.projectsDir(),
    approvalsFile: join(o.home, KNOWLEDGE_APPROVALS_FILE),
    log: o.log,
  });
  const taskJournal = new TaskJournal({
    file: join(o.home, TASK_JOURNAL_FILE),
    log: o.log,
    maxRecords: TASK_JOURNAL_MAX_RECORDS,
    masker: async () => {
      const env = await o.userEnv();
      return (text) => logs.mask(text, env);
    },
  });
  const agents = new Agents({
    procs,
    // `terminals` needs `agents` for the task worktrees, so it is made below; a task ends only after both.
    closeFolderTerminal: (task): Promise<void> => terminals.closeTask(task),
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
    knowledge: (repo) => knowledge.forSession(repo),
    // `verifications` and `mergeRequests` are made below: the outcomes are read only once a supervisor gets a prompt,
    // and a task ends only after both exist.
    taskOutcomes,
    onTaskRemoved: (ended) => {
      logs.removeTaskLogs(ended.task);
      const last = verifications.take(ended.task);
      // `record` logs its own failures, so ending the task does not wait for the write.
      void taskJournal.record({ ...ended, verification: last && { state: last.state, finishedAt: last.finishedAt } });
    },
    // `graph` is made below; a task's turn ends only after it exists.
    taskImpact: (task) => taskImpact(task),
    log: o.log,
  });
  // A removal that failed on a held file, or a crash before it, leaves an ended task's logs behind (ADR-59). Without a
  // readable `tasks.json` (moved aside as broken, and it may come back) nothing is removed.
  if (agents.taskListRead()) logs.removeTaskLogsExcept(agents.sessions().tasks.map((t) => t.id));
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
  const taskImpact = ({ repo, worktree, base }: Task) => graph.changedEndpoints(repo, worktree, base);
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
    jobLogExcerpt: async (raw, cut) => logs.jobLogExcerpt(raw, await o.userEnv(), cut),
    onPipelineFailed: (task, mergeRequest) => agents.pipelineFailed(task.id, mergeRequest),
    log: o.log,
  });
  const dayStart = new DayStart({
    workspace,
    agents,
    vcs,
    file: new DayStartFile(join(o.home, DAY_START_FILE), o.log),
    log: o.log,
  });
  const errorJournal = createErrorJournal({ ...o, workspace });
  const mcpAudit = new McpAudit({ dir: join(o.home, LOGS_DIR), log: o.log });
  const usageReport = new UsageReport({
    copilotHome: async () => copilotHome(await o.userEnv()),
    places: () => knownPlaces(agents, taskJournal, workspace),
    now: Date.now,
    log: o.log,
  });
  const javaNavigationReadiness = () => agents.javaNavigationState();
  const javaNavigation = new JavaNavigation({
    repos: workspace,
    readiness: javaNavigationReadiness,
    release: o.jdtlsRelease ?? JDTLS_RELEASE,
    lombok: o.lombokRelease ?? LOMBOK_RELEASE,
    java: JDTLS_JAVA,
    cards: async () => (await cards.all()).cards.map((c) => (c.kind === "ok" ? c.card : null)),
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
    unpushedWork: () => workspace.unpushedWork(),
    remoteReach: () => workspace.remoteReach(),
    mountTable,
    diskSpace: o.diskSpace ?? diskSpace,
    homeDir: homedir(),
    inContainer: o.inContainer,
    workspaceFile: workspace.configFile(),
    workspaceKeys: () => workspace.workspaceKeys(),
    javaNavigation: javaNavigationReadiness,
    sandbox: () => agents.sandboxState(),
    probeTls: o.tlsProbe ?? probeTls,
    // Where a free session starts: the projects folder, with the session profile mise reads there.
    // Without a profile mise is not asked, so nothing decrypts the provider's key for a check that would drop it.
    profileEnvironment: async () =>
      workspace.sessionProfile() === null ? null : profileEnvironment(await o.userEnv(), await mise.sessionEnv({ repo: null, task: null })),
    probeConnection: o.connectionProbe ?? probeConnection,
    systemCaFiles: SYSTEM_CA_FILES,
    now: () => new Date(),
  });
  const providerModels = new ProviderModels({
    // As a free session gets it in the projects folder, the provider's key included, which stays in the daemon; without a
    // profile mise is not asked, so nothing decrypts a key for a list sessions on GitHub's models do not use.
    profileEnv: async () => {
      const profile = workspace.sessionProfile();
      if (profile === null) return null;
      const mised = await mise.sessionEnv({ repo: null, task: null });
      return { profile, env: withMiseVars(await o.userEnv(), mised.vars), problem: mised.problem };
    },
    ca: async (env) => (await sessionCertificates(env, SYSTEM_CA_FILES)).ca,
  });
  const configFiles = new ConfigFiles({
    stateDir: { path: o.home, from: o.homeFrom },
    statePaths: {
      "workspace-file": workspace.configFile(),
      "tasks-file": join(o.home, TASKS_FILE),
      "task-rounds-file": join(o.home, TASK_ROUNDS_FILE),
      "resumable-sessions-file": join(o.home, RESUMABLE_SESSIONS_FILE),
      "last-supervisor-file": join(o.home, LAST_SUPERVISOR_FILE),
      "agent-queues-file": join(o.home, AGENT_QUEUES_FILE),
      "verifications-file": join(o.home, VERIFICATIONS_FILE),
      "auto-reviews-file": join(o.home, AUTO_REVIEWS_FILE),
      "task-journal-file": join(o.home, TASK_JOURNAL_FILE),
      "day-start-file": join(o.home, DAY_START_FILE),
      "routine-approvals-file": join(o.home, ROUTINE_APPROVALS_FILE),
      "knowledge-approvals-file": join(o.home, KNOWLEDGE_APPROVALS_FILE),
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
      const env = await mise.projectsEnv();
      return { variables: Object.keys(env.vars), secrets: env.secretNames, problem: env.problem };
    },
    localConfigStore: () => localConfig.store(),
    openEditor: (path) => o.openUrl(vscodeUrl(path)),
    openFolder: o.openFolder,
  });
  /** The outcome of every task with a verification or a merge request (ADR-154), for the UI and the supervisor (ADR-156). */
  function taskOutcomes(): TaskOutcome[] {
    const followed = mergeRequests.followed();
    return agents.tasks().flatMap((task) => {
      const verification = verifications.get(task.id)?.state ?? null;
      const mergeRequest = followed.get(task.id) ?? null;
      return verification === null && mergeRequest === null ? [] : [{ task: task.id, repo: task.repo, verification, mergeRequest }];
    });
  }

  const placeFolder = async ({ repo, task }: TerminalPlace): Promise<string> => {
    if (repo === null) {
      if (task !== null) throw new DomainError("bad_request", "a task's place names its repo");
      return workspace.projectsDir();
    }
    return task === null ? workspace.repoPath(repo) : agents.taskWorktreeForShell(task, repo);
  };
  const terminals: FolderTerminals = new FolderTerminals({
    procs,
    folder: placeFolder,
    env: o.userEnv,
    shell: (env) => userShell(env),
    log: o.log,
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
    routines,
    knowledge,
    agents,
    services,
    terminals,
    folderFiles: new FolderFiles({ folder: placeFolder }),
    testReports,
    verifications,
    taskJournal,
    mergeRequests,
    dayStart,
    errorJournal,
    mcpAudit,
    usageReport,
    doctor,
    providerModels,
    javaNavigation,
    configFiles,
    openLink: o.openUrl,
    taskChangedEndpoints: async (task) => ({ task, ...(await taskImpact(agents.task(task))) }),
    runRoutine: async (name, digest, view) => {
      const { repo, prompt, title, model, approvals } = await routines.approved(name, digest);
      return agents.createTask(repo, prompt, { title, model, approvals, view });
    },
    appConfig: async ({ repo, task, profile, key }) => {
      const dir = task === null ? await workspace.repoPath(repo) : agents.taskOfRepo(task, repo).worktree;
      const run = await mise.runEnv({ repo, task });
      const mask = logs.masker(run.env, run.secretValues);
      const read = await cards.appConfig(dir, { profile, key }, { vars: run.env, mask });
      return { repo, task, profile, ...read, envProblem: run.problem === null ? null : mask(run.problem) };
    },
    taskOutcomes,
    keepForRestart: () => {
      agents.keepRunningSessionsForResume();
      verifications.keepForRestart();
    },
  };
}

/**
 * The tasks, repos and projects folder the usage report ties conversations to (ADR-199): running tasks from `agents`,
 * ended ones from the task journal with the worktree they had, and the repos without git, which only their folders are
 * needed of. A workspace that cannot be read fails the report, which says why, instead of showing every conversation
 * outside the projects folder.
 */
async function knownPlaces(agents: Agents, taskJournal: TaskJournal, workspace: Workspace): Promise<KnownPlaces> {
  const list = await workspace.entryList();
  // Without a projects folder or with a worktrees folder Settings refuses, ended tasks are matched without their worktree.
  const worktreesDir = await workspace.worktreesDir().catch(() => null);
  return {
    tasks: [
      ...agents.tasks().map((t) => ({ id: t.id, repo: t.repo, branch: t.branch, worktree: t.worktree, title: t.title, prompt: t.prompt })),
      ...taskJournal.records().map((r) => ({
        id: r.task,
        repo: r.repo,
        branch: r.branch,
        worktree: worktreesDir === null ? null : taskWorktree(worktreesDir, r.repo, r.branch),
        title: r.title,
        prompt: r.prompt,
      })),
    ],
    repos: list.repos.map((r) => ({ id: r.id, path: r.path })),
    projectsDir: list.projectsDir,
    isTaskBranch: (branch) => TaskBranch.safeParse(branch).success,
  };
}
