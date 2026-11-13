import type { CardWarmupProgress, McpAuditRevision, SessionList } from "@trackwall/protocol";
import { type ReactNode, useState } from "react";
import { RemoteDaemonSurface } from "@/components/RemoteDaemonSurface";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import { SETTINGS_CATEGORIES, type SettingsCategory, type SettingsSection, settingsCategory } from "@/lib/settings-categories";
import type { AppUpdateHandle } from "@/lib/use-app-update";
import { cn } from "@/lib/utils";
import { AutoReviewSurface } from "./AutoReviewSurface.tsx";
import { BrowserNotificationsSurface } from "./BrowserNotificationsSurface.tsx";
import { ConfigFilesSurface } from "./ConfigFilesSurface.tsx";
import { ConnectCopilotSurface } from "./ConnectCopilotSurface.tsx";
import { CopilotUsageSurface } from "./CopilotUsageSurface.tsx";
import { DaemonSurface } from "./DaemonSurface.tsx";
import { DoctorSurface } from "./DoctorSurface.tsx";
import { ErrorJournalSurface } from "./ErrorJournalSurface.tsx";
import { HomeSceneSurface } from "./HomeSceneSurface.tsx";
import { JavaNavigationSurface } from "./JavaNavigationSurface.tsx";
import { KeepScreenOnSurface } from "./KeepScreenOnSurface.tsx";
import { LocalConfigReposSurface } from "./LocalConfigReposSurface.tsx";
import { LocalConfigStoreSurface } from "./LocalConfigStoreSurface.tsx";
import { McpCallsSurface } from "./McpCallsSurface.tsx";
import { ModelStatsSurface } from "./ModelStatsSurface.tsx";
import { RepoHostsSurface } from "./RepoHostsSurface.tsx";
import { RetryModelSurface } from "./RetryModelSurface.tsx";
import { RunningTasksWarningSurface } from "./RunningTasksWarningSurface.tsx";
import { SandboxSurface } from "./SandboxSurface.tsx";
import { SessionProfileSurface } from "./SessionProfileSurface.tsx";
import { StartAtSignInSurface } from "./StartAtSignInSurface.tsx";
import { SupervisorChangesCodeSurface } from "./SupervisorChangesCodeSurface.tsx";
import { SupervisorModelSurface } from "./SupervisorModelSurface.tsx";
import { TaskTokenBudgetSurface } from "./TaskTokenBudgetSurface.tsx";
import { ThemeSurface } from "./ThemeSurface.tsx";
import { UpdatesSurface } from "./UpdatesSurface.tsx";
import { VsCodeExtensionSurface } from "./VsCodeExtensionSurface.tsx";
import { WorkspaceFolders } from "./WorkspaceFolders.tsx";

type SettingsProps = {
  conn: Connection;
  update: AppUpdateHandle | undefined;
  warmupLive: LiveFeed<CardWarmupProgress> | undefined;
  mcpCallsLive: LiveFeed<McpAuditRevision> | undefined;
  /** The session list, to tell how many running sessions keep another session profile (ADR-178). */
  sessions: SessionList | undefined;
  /** Reconnects to the daemon, for a read that failed because the daemon is gone. */
  onRetry: () => void;
  /** After the projects folder is saved, so that the app can show its repos. */
  onSaved: () => void;
};

/**
 * Settings (ADR-102): the list of categories on the left and the sections of the chosen one on the right; in a narrow
 * window, for example next to the supervisor panel, the list becomes a row above the sections. Each setting is also a
 * key in `workspace.yaml`, which can be edited by hand (ADR-13, ADR-18, ADR-84). The view is as wide as a wide category
 * needs (ADR-212), so the list stays in one place when the user moves between categories.
 */
export function SettingsView({ initialCategory, ...props }: SettingsProps & { initialCategory: SettingsCategory }) {
  const [current, setCurrent] = useState(initialCategory);
  const category = settingsCategory(current);
  return (
    <div className="@container w-full max-w-6xl">
      <div className="flex flex-col gap-4 @3xl:flex-row @3xl:items-start @3xl:gap-6">
        <nav aria-label="Settings categories" className="flex shrink-0 gap-1 overflow-x-auto @3xl:w-44 @3xl:flex-col">
          {SETTINGS_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              aria-current={c.id === current ? "page" : undefined}
              onClick={() => setCurrent(c.id)}
              className={cn(
                "shrink-0 rounded-md px-3 py-1.5 text-left text-sm whitespace-nowrap transition-colors",
                c.id === current ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              {c.label}
            </button>
          ))}
        </nav>
        <div className={cn("flex w-full min-w-0 flex-col gap-4", !category.wide && "max-w-xl")}>
          <header className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold">{category.label}</h1>
            <p className="text-muted-foreground text-sm">{category.description}</p>
          </header>
          {category.sections.map((section) => (
            <Section key={section} section={section} {...props} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Section({
  section,
  conn,
  update,
  warmupLive,
  mcpCallsLive,
  sessions,
  onRetry,
  onSaved,
}: SettingsProps & { section: SettingsSection }): ReactNode {
  switch (section) {
    case "folders":
      return <WorkspaceFolders conn={conn} onRetry={onRetry} onSaved={onSaved} />;
    case "local-config-store":
      return <LocalConfigStoreSurface conn={conn} />;
    case "repo-hosts":
      return <RepoHostsSurface conn={conn} />;
    case "copilot-cli":
      return <ConnectCopilotSurface conn={conn} onRetry={onRetry} />;
    case "session-profile":
      return <SessionProfileSurface conn={conn} sessions={sessions} />;
    case "supervisor-model":
      return <SupervisorModelSurface conn={conn} />;
    case "supervisor-changes-code":
      return <SupervisorChangesCodeSurface conn={conn} />;
    case "retry-model":
      return <RetryModelSurface conn={conn} />;
    case "task-token-budget":
      return <TaskTokenBudgetSurface conn={conn} />;
    case "running-tasks-warning":
      return <RunningTasksWarningSurface conn={conn} />;
    case "sandbox":
      return <SandboxSurface conn={conn} />;
    case "auto-review":
      return <AutoReviewSurface conn={conn} />;
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
    case "home-scene":
      return <HomeSceneSurface />;
    case "daemon":
      return <DaemonSurface conn={conn} warmupLive={warmupLive} onRetry={onRetry} />;
    case "config-files":
      return <ConfigFilesSurface conn={conn} />;
    case "local-config-repos":
      return <LocalConfigReposSurface conn={conn} />;
    case "doctor":
      return <DoctorSurface conn={conn} />;
    case "trackwall-errors":
      return <ErrorJournalSurface conn={conn} />;
  }
}
