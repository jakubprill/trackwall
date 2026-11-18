import { agentsApi, type SessionView, type SupervisorConversation } from "@trackwall/protocol";
import { Check, Circle, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { readSupervisorView, saveSupervisorView } from "@/lib/conversation";
import { type DayStartStepStatus, dayStartSteps, type StartButton, startErrorShown } from "@/lib/day-start";
import { type SupervisorChoice, type SupervisorSummary, supervisorChoices } from "@/lib/supervisor";
import { useAction } from "@/lib/use-action";
import type { DayStartHandle } from "@/lib/use-day-start";
import { cn } from "@/lib/utils";

/**
 * The start card of the supervisor panel while no supervisor runs (ADR-126): each way to start it with one sentence on
 * what it does, the main one first and highlighted, and the view the start opens in. While a day start runs, its steps.
 * Before a projects folder is set it asks for one instead, since the supervisor runs in it (ADR-58) and every start
 * would fail.
 */
export function SupervisorStart({
  conn,
  supervisor,
  day,
  lastStart,
  projectsDir,
  onStart,
  onChanged,
  onOpenGetStarted,
}: {
  conn: Connection;
  supervisor: SupervisorSummary;
  day: DayStartHandle;
  /** The kind of start the user pressed last, whose error the card shows. */
  lastStart: StartButton;
  /** The projects folder; `null` while none is set, `undefined` while the settings are on their way, which keeps the starts. */
  projectsDir: string | null | undefined;
  onStart: (button: StartButton) => void;
  onChanged: () => void;
  /** Opens Settings › Get started, where the projects folder is set. */
  onOpenGetStarted: () => void;
}) {
  const [view, setView] = useState(() => readSupervisorView(() => window.localStorage));
  const chooseView = (next: SessionView) => {
    setView(next);
    saveSupervisorView(() => window.localStorage, next);
  };
  const start = useAction(
    (conversation: SupervisorConversation) => post(conn, agentsApi.startSupervisor, { conversation, view }),
    onChanged,
  );
  const steps = dayStartSteps(day.run);
  if (steps.length > 0) return <DayStartSteps steps={steps} />;
  const error = startErrorShown({
    lastStart,
    supervisorError: start.error,
    dayError: day.error,
    dayRun: day.run,
    supervisorStartedAt: supervisor.session?.startedAt,
  });
  const run = (choice: SupervisorChoice) => {
    if (choice.kind === "day") {
      onStart("day");
      day.start(view);
    } else {
      onStart("supervisor");
      start.run(choice.kind);
    }
  };
  const [main, ...others] = supervisorChoices(supervisor, day.run, new Date());
  const pending = start.pending || day.running;
  // Under the card is the last supervisor's screen, so the other choices take one line there.
  const compact = supervisor.session !== undefined;
  return (
    <section aria-label="Start the supervisor" className="flex flex-col gap-3 border-b px-4 py-3">
      {!compact && (
        <p className="text-muted-foreground text-sm">
          One Copilot CLI session above all your repos. Tell it what you want done; it plans the work and proposes a task for each repo, and
          nothing starts without your approval in Sessions.
        </p>
      )}
      {projectsDir === null ? (
        <ProjectsFolderFirst onOpenGetStarted={onOpenGetStarted} />
      ) : (
        <>
          {main && <Choice choice={main} main disabled={pending} onRun={() => run(main)} />}
          {compact ? (
            <div className="flex flex-wrap gap-2">
              {others.map((choice) => (
                <Button
                  key={choice.kind}
                  variant="outline"
                  size="sm"
                  title={choice.description}
                  disabled={pending}
                  onClick={() => run(choice)}
                >
                  {choice.button}
                </Button>
              ))}
            </div>
          ) : (
            others.map((choice) => <Choice key={choice.kind} choice={choice} disabled={pending} onRun={() => run(choice)} />)
          )}
          <ViewChoice view={view} onView={chooseView} />
        </>
      )}
      {error && <p className="text-destructive text-xs">{error}</p>}
    </section>
  );
}

/**
 * In place of the starts while no projects folder is set: where to set it. Not highlighted, so that the next step of
 * the view next to the panel, such as Home's "Get started", stays the one bright button.
 */
function ProjectsFolderFirst({ onOpenGetStarted }: { onOpenGetStarted: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-md border p-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">Set your projects folder first</span>
        <span className="text-muted-foreground text-xs">
          The supervisor works in the folder with your repos, so it starts once that folder is set.
        </span>
      </div>
      <Button size="sm" variant="outline" onClick={onOpenGetStarted}>
        Get started
      </Button>
    </div>
  );
}

function Choice({
  choice,
  main = false,
  disabled,
  onRun,
}: {
  choice: SupervisorChoice;
  main?: boolean;
  disabled: boolean;
  onRun: () => void;
}) {
  return (
    <div className={cn("flex items-center gap-3 rounded-md border p-3", main && "border-primary/50 bg-primary/5")}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-sm font-medium">{choice.title}</span>
        <span className="text-muted-foreground text-xs">{choice.description}</span>
      </div>
      <Button size="sm" variant={main ? "default" : "outline"} disabled={disabled} onClick={onRun}>
        {choice.button}
      </Button>
    </div>
  );
}

/** Which view the start opens the supervisor in: a terminal, or the conversation view (ADR-107), still a preview. */
function ViewChoice({ view, onView }: { view: SessionView; onView: (view: SessionView) => void }) {
  const options: { view: SessionView; label: string }[] = [
    { view: "terminal", label: "Terminal" },
    { view: "conversation", label: "Chat (preview)" },
  ];
  return (
    <div className="text-muted-foreground flex items-center gap-2 text-xs">
      <span id="supervisor-view">Show as</span>
      <fieldset aria-labelledby="supervisor-view" className="border-input flex min-w-0 overflow-hidden rounded-md border">
        {options.map((option) => (
          <button
            key={option.view}
            type="button"
            aria-pressed={view === option.view}
            onClick={() => onView(option.view)}
            className={cn("px-2 py-1", view === option.view ? "bg-accent text-foreground" : "hover:bg-accent/50")}
          >
            {option.label}
          </button>
        ))}
      </fieldset>
    </div>
  );
}

const STEP_ICON: Record<DayStartStepStatus, typeof Check> = { done: Check, now: LoaderCircle, next: Circle };

/** A running day start: its steps, what is done and what is still ahead. */
function DayStartSteps({ steps }: { steps: { label: string; status: DayStartStepStatus }[] }) {
  return (
    <section aria-label="Starting your day" className="flex flex-col gap-2 border-b px-4 py-3 text-sm">
      <ol className="flex flex-col gap-1.5">
        {steps.map(({ label, status }) => {
          const Icon = STEP_ICON[status];
          return (
            <li key={label} className={cn("flex items-center gap-2", status === "next" && "text-muted-foreground")}>
              <Icon
                className={cn("size-4 shrink-0", status === "done" && "text-success", status === "now" && "text-primary animate-spin")}
                aria-hidden
              />
              {label}
            </li>
          );
        })}
      </ol>
      <p className="text-muted-foreground text-xs">The supervisor opens here when the briefing is ready.</p>
    </section>
  );
}
