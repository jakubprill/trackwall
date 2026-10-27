import type { CardWarmupProgress } from "@trackwall/protocol";
import { type ReactNode, useState } from "react";
import type { Connection } from "@/lib/connection";
import type { LiveFeed } from "@/lib/daemon-events";
import { SETTINGS_CATEGORIES, type SettingsCategory, type SettingsSection, settingsCategory } from "@/lib/settings-categories";
import type { AppUpdateHandle } from "@/lib/use-app-update";
import { cn } from "@/lib/utils";
import { ConnectCopilotSurface } from "./ConnectCopilotSurface.tsx";
import { DaemonSurface } from "./DaemonSurface.tsx";
import { LocalConfigStoreSurface } from "./LocalConfigStoreSurface.tsx";
import { RepoHostsSurface } from "./RepoHostsSurface.tsx";
import { StartAtSignInSurface } from "./StartAtSignInSurface.tsx";
import { UpdatesSurface } from "./UpdatesSurface.tsx";
import { WorkspaceFolders } from "./WorkspaceFolders.tsx";

type SettingsProps = {
  conn: Connection;
  update: AppUpdateHandle | undefined;
  warmupLive: LiveFeed<CardWarmupProgress> | undefined;
  /** Reconnects to the daemon, for a read that failed because the daemon is gone. */
  onRetry: () => void;
  /** After the projects folder is saved, so that the app can show its repos. */
  onSaved: () => void;
};

/**
 * Settings (ADR-102): the list of categories on the left and the sections of the chosen one on the right; in a narrow
 * window, for example next to the supervisor panel, the list becomes a row above the sections. Each setting is also a
 * key in `workspace.yaml`, which can be edited by hand (ADR-13, ADR-18, ADR-84).
 */
export function SettingsView({ initialCategory, ...props }: SettingsProps & { initialCategory: SettingsCategory }) {
  const [current, setCurrent] = useState(initialCategory);
  const category = settingsCategory(current);
  return (
    <div className="@container w-full max-w-4xl">
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
        <div className="flex w-full max-w-xl min-w-0 flex-col gap-4">
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

function Section({ section, conn, update, warmupLive, onRetry, onSaved }: SettingsProps & { section: SettingsSection }): ReactNode {
  switch (section) {
    case "folders":
      return <WorkspaceFolders conn={conn} onRetry={onRetry} onSaved={onSaved} />;
    case "local-config-store":
      return <LocalConfigStoreSurface conn={conn} />;
    case "repo-hosts":
      return <RepoHostsSurface conn={conn} />;
    case "copilot-cli":
      return <ConnectCopilotSurface conn={conn} onRetry={onRetry} />;
    case "start-at-sign-in":
      return <StartAtSignInSurface />;
    case "updates":
      return <UpdatesSurface handle={update} />;
    case "daemon":
      return <DaemonSurface conn={conn} warmupLive={warmupLive} onRetry={onRetry} />;
  }
}
