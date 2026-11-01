import { type JavaNavigationInstall, javaNavigationApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { type JavaNavigationSetupTone, javaNavigationSetup } from "@/lib/java-navigation";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";
import { cn } from "@/lib/utils";

/** Asked every second while an install runs, to show its step; otherwise now and then, for a path that went missing. */
const RUNNING_POLL_MS = 1000;
const IDLE_POLL_MS = 30_000;

const TONE_CLASS: Record<JavaNavigationSetupTone, string> = {
  muted: "text-muted-foreground",
  ok: "text-success",
  warning: "text-warning",
  error: "text-destructive",
};

/**
 * Java navigation for tasks (ADR-99, ADR-123, ADR-167): one button installs the jdtls release and Lombok jar Trackwall
 * pins, the Java jdtls runs on and the Java versions the repos build with, and saves their paths in `workspace.yaml`; the line under it says how far it got and whether tasks can get it.
 */
export function JavaNavigationSurface({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, javaNavigationApi.state, {}), [conn]);
  const install = useRemote(load, { pollMs: (data) => (data?.step ? RUNNING_POLL_MS : IDLE_POLL_MS) });
  const start = useAction(() => post(conn, javaNavigationApi.startInstall, {}), install.reload);
  return (
    <Surface label="Java navigation">
      <div className="flex flex-col gap-3 p-4">
        {install.error && <ErrorWithRetry message={install.error} onRetry={install.reload} />}
        {!install.data && !install.error && <Loading />}
        {install.data && <JavaNavigationSetup install={install.data} pending={start.pending} onInstall={start.run} />}
        {start.error && <p className="text-destructive text-xs break-words">{start.error}</p>}
      </div>
    </Surface>
  );
}

function JavaNavigationSetup({ install, pending, onInstall }: { install: JavaNavigationInstall; pending: boolean; onInstall: () => void }) {
  const setup = javaNavigationSetup(install);
  return (
    <>
      <p className="text-muted-foreground text-sm">
        Gives agent tasks in Java repos a language server, so the agent finds definitions and usages instead of searching text. Install
        downloads jdtls {install.jdtls} and Lombok {install.lombok} into your projects folder, and with mise Java {install.java} and the
        Java versions your repos build with, about 250 MB plus some 300 MB for each such Java. Install again with no Java navigation tasks
        running, also after adding a repo that builds with another Java.
      </p>
      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" disabled={pending || install.step !== null} onClick={onInstall}>
          {setup.button}
        </Button>
        <span className={cn("min-w-0 text-xs break-words", TONE_CLASS[setup.tone])}>{setup.line}</span>
      </div>
    </>
  );
}
