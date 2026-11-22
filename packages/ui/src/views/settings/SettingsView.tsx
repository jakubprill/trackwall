import {
  type CardWarmupProgress,
  type DoctorReport,
  type McpAuditRevision,
  type SessionList,
  type WorkspaceSettings,
  workspaceApi,
} from "@trackwall/protocol";
import { type ReactNode, useCallback, useState } from "react";
import { RemoteDaemonSurface } from "@/components/RemoteDaemonSurface";
import { Surface } from "@/components/Surface";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import { useOpenSteps } from "@/lib/get-started-memory";
import { SETTING_ROWS, type SettingRowId, type SettingSources, settingRowOpen, settingsParts, settingValue } from "@/lib/setting-rows";
import { type SettingsCategory, type SettingsSection, settingsCategory } from "@/lib/settings-categories";
import { useTheme } from "@/lib/theme-controller";
import type { AppUpdateHandle } from "@/lib/use-app-update";
import { useDoctorReport } from "@/lib/use-doctor-report";
import type { HomeOnBarChoice } from "@/lib/use-home-on-bar";
import { type RemoteHandle, useRemote } from "@/lib/use-remote";
import { cn } from "@/lib/utils";
import { AlwaysAllowSurface } from "./AlwaysAllowSurface.tsx";
import { AutoReviewSurface } from "./AutoReviewSurface.tsx";
import { BrowserNotificationsSurface } from "./BrowserNotificationsSurface.tsx";
import { ConfigFilesSurface } from "./ConfigFilesSurface.tsx";
import { ConnectCopilotSurface } from "./ConnectCopilotSurface.tsx";
import { ContainerHealthSurface } from "./ContainerHealthSurface.tsx";
import { CopilotUsageSurface } from "./CopilotUsageSurface.tsx";
import { DaemonSurface } from "./DaemonSurface.tsx";
import { DoctorSurface } from "./DoctorSurface.tsx";
import { ErrorJournalSurface } from "./ErrorJournalSurface.tsx";
import { GetStartedSurface } from "./GetStartedSurface.tsx";
import { GitProgramSurface } from "./GitProgramSurface.tsx";
import { HomeSurface } from "./HomeSurface.tsx";
import { JavaNavigationSurface } from "./JavaNavigationSurface.tsx";
import { KeepScreenOnSurface } from "./KeepScreenOnSurface.tsx";
import { LocalConfigReposSurface } from "./LocalConfigReposSurface.tsx";
import { LocalConfigStoreSurface } from "./LocalConfigStoreSurface.tsx";
import { McpCallsSurface } from "./McpCallsSurface.tsx";
import { ModelStatsSurface } from "./ModelStatsSurface.tsx";
import { ProjectsFolderSurface } from "./ProjectsFolderSurface.tsx";
import { RepoHostsSurface } from "./RepoHostsSurface.tsx";
import { RetryModelSurface } from "./RetryModelSurface.tsx";
import { RunningTasksWarningSurface } from "./RunningTasksWarningSurface.tsx";
import { SandboxSurface } from "./SandboxSurface.tsx";
import { ServerCheckSurface } from "./ServerCheckSurface.tsx";
import { SessionProfileSurface } from "./SessionProfileSurface.tsx";
import { SettingRow } from "./SettingRow.tsx";
import { SettingsNav } from "./SettingsNav.tsx";
import { StartAtSignInSurface } from "./StartAtSignInSurface.tsx";
import { SupervisorChangesCodeSurface } from "./SupervisorChangesCodeSurface.tsx";
import { SupervisorModelSurface } from "./SupervisorModelSurface.tsx";
import { TaskTokenBudgetSurface } from "./TaskTokenBudgetSurface.tsx";
import { ThemeSurface } from "./ThemeSurface.tsx";
import { UpdatesSurface } from "./UpdatesSurface.tsx";
import { VsCodeExtensionSurface } from "./VsCodeExtensionSurface.tsx";
import { WorkBackupSurface } from "./WorkBackupSurface.tsx";
import { WorktreesDirSurface } from "./WorktreesDirSurface.tsx";

type SettingsProps = {
  conn: Connection;
  update: AppUpdateHandle | undefined;
  warmupLive: LiveFeed<CardWarmupProgress> | undefined;
  mcpCallsLive: LiveFeed<McpAuditRevision> | undefined;
  /** The session list, to tell how many running sessions keep another session profile (ADR-178). */
  sessions: SessionList | undefined;
  /** Whether the view bar shows Home (ADR-294), which `App` keeps, as the bar is its. */
  homeOnBar: HomeOnBarChoice;
  /** Reconnects to the daemon, for a read that failed because the daemon is gone. */
  onRetry: () => void;
  /** After the projects folder is saved, so that the app can show its repos. */
  onSaved: () => void;
  /** Shows where sessions start, from "Get started" once it is ready. */
  onStart: () => void;
};

/**
 * Settings (ADR-102): the list of categories on the left and the sections of the chosen one on the right; in a narrow
 * window, for example next to the supervisor panel, the list becomes a row above the sections. Each setting is also a
 * key in `workspace.yaml`, which can be edited by hand (ADR-13, ADR-18, ADR-84). The view is as wide as a wide category
 * needs (ADR-212), so the list stays in one place when the user moves between categories, and starts at the left edge
 * of the window (ADR-262). "Get started" and "Diagnostics" show one run of the doctor (`useDoctorReport`), whose open steps
 * stay as a line under "Get started" in the list (`SettingsNav`, ADR-268). A setting is a folded row (ADR-263): the rows of a category read their values from
 * one read of the workspace settings, which their forms share, so a saved value shows in its row at once.
 */
export function SettingsView({ initialCategory, ...props }: SettingsProps & { initialCategory: SettingsCategory }) {
  const [current, setCurrent] = useState(initialCategory);
  const category = settingsCategory(current);
  const doctor = useDoctorReport(
    props.conn,
    category.sections.some((s) => s === "get-started" || s === "doctor"),
  );
  const open = useOpenSteps(doctor.data);
  const loadSettings = useCallback(() => post(props.conn, workspaceApi.settings, {}), [props.conn]);
  const settings = useRemote(loadSettings);
  const sectionProps = { ...props, doctor, settings, onOpenCategory: setCurrent };
  const sources: SettingSources = {
    settings: settings.data,
    settingsFailed: settings.error !== undefined,
    theme: useTheme().choice,
    homeOnBar: props.homeOnBar.value,
  };
  return (
    <div className="@container w-full max-w-6xl">
      <div className="flex flex-col gap-4 @3xl:flex-row @3xl:items-start @3xl:gap-6">
        <SettingsNav current={current} openSteps={open} onSelect={setCurrent} />
        <div className={cn("flex w-full min-w-0 flex-col gap-4", !category.wide && "max-w-xl")}>
          <header className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold">{category.label}</h1>
            <p className="text-muted-foreground text-sm">{category.description}</p>
          </header>
          {settingsParts(category.sections).map((part) =>
            part.kind === "section" ? (
              <Section key={part.section} section={part.section} {...sectionProps} />
            ) : (
              <Surface key={part.group} label={part.group}>
                {part.rows.map((row) => (
                  <SettingRowOf key={row} row={row} sources={sources}>
                    <Section section={row} {...sectionProps} />
                  </SettingRowOf>
                ))}
              </Surface>
            ),
          )}
        </div>
      </div>
    </div>
  );
}

/** One setting's folded row, which remembers whether the user opened or folded it while the category is shown. */
function SettingRowOf({ row, sources, children }: { row: SettingRowId; sources: SettingSources; children: ReactNode }) {
  const [toggled, setToggled] = useState<boolean>();
  const value = settingValue(row, sources);
  const open = settingRowOpen(toggled, value);
  return (
    <SettingRow {...SETTING_ROWS[row]} value={value} open={open} onToggle={() => setToggled(!open)}>
      {children}
    </SettingRow>
  );
}

function Section({
  section,
  doctor,
  settings,
  onOpenCategory,
  onStart,
  conn,
  update,
  warmupLive,
  mcpCallsLive,
  sessions,
  homeOnBar,
  onRetry,
  onSaved,
}: SettingsProps & {
  section: SettingsSection;
  doctor: RemoteHandle<DoctorReport>;
  settings: RemoteHandle<WorkspaceSettings>;
  onOpenCategory: (category: SettingsCategory) => void;
}): ReactNode {
  switch (section) {
    case "get-started":
      return (
        <GetStartedSurface
          conn={conn}
          report={doctor}
          settings={settings}
          onRetry={onRetry}
          onStart={onStart}
          onOpenDiagnostics={() => onOpenCategory("diagnostics")}
        />
      );
    case "projects-folder":
      return <ProjectsFolderSurface conn={conn} settings={settings} onRetry={onRetry} onSaved={onSaved} />;
    case "worktrees-dir":
      return <WorktreesDirSurface conn={conn} settings={settings} />;
    case "git-program":
      return <GitProgramSurface conn={conn} settings={settings} />;
    case "local-config-store":
      return <LocalConfigStoreSurface conn={conn} />;
    case "work-backup":
      return <WorkBackupSurface conn={conn} />;
    case "repo-hosts":
      return <RepoHostsSurface conn={conn} />;
    case "server-check":
      return <ServerCheckSurface conn={conn} settings={settings} />;
    case "copilot-cli":
      return <ConnectCopilotSurface conn={conn} onRetry={onRetry} />;
    case "session-profile":
      return <SessionProfileSurface conn={conn} settings={settings} sessions={sessions} />;
    case "supervisor-model":
      return <SupervisorModelSurface conn={conn} settings={settings} />;
    case "supervisor-changes-code":
      return <SupervisorChangesCodeSurface conn={conn} settings={settings} />;
    case "retry-model":
      return <RetryModelSurface conn={conn} settings={settings} />;
    case "task-token-budget":
      return <TaskTokenBudgetSurface conn={conn} settings={settings} />;
    case "running-tasks-warning":
      return <RunningTasksWarningSurface conn={conn} settings={settings} />;
    case "always-allow":
      return <AlwaysAllowSurface conn={conn} settings={settings} />;
    case "sandbox":
      return <SandboxSurface conn={conn} settings={settings} />;
    case "auto-review":
      return <AutoReviewSurface conn={conn} settings={settings} />;
    case "java-navigation":
      return <JavaNavigationSurface conn={conn} />;
    case "mcp-calls":
      return <McpCallsSurface conn={conn} live={mcpCallsLive} />;
    case "copilot-usage":
      return <CopilotUsageSurface conn={conn} />;
    case "model-stats":
      return <ModelStatsSurface conn={conn} />;
    case "start-at-sign-in":
      return <StartAtSignInSurface />;
    case "keep-screen-on":
      return <KeepScreenOnSurface />;
    case "remote-daemon":
      return <RemoteDaemonSurface />;
    case "browser-notifications":
      return <BrowserNotificationsSurface />;
    case "vscode-extension":
      return <VsCodeExtensionSurface conn={conn} />;
    case "updates":
      return <UpdatesSurface handle={update} />;
    case "theme":
      return <ThemeSurface />;
    case "home":
      return <HomeSurface onBar={homeOnBar} />;
    case "daemon":
      return <DaemonSurface conn={conn} warmupLive={warmupLive} onRetry={onRetry} />;
    case "config-files":
      return <ConfigFilesSurface conn={conn} />;
    case "local-config-repos":
      return <LocalConfigReposSurface conn={conn} />;
    case "doctor":
      return <DoctorSurface report={doctor} />;
    case "container-health":
      return <ContainerHealthSurface conn={conn} />;
    case "trackwall-errors":
      return <ErrorJournalSurface conn={conn} />;
  }
}
