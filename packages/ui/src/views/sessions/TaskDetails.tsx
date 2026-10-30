import type { Session, Task } from "@trackwall/protocol";
import type { ReactNode } from "react";
import type { Connection } from "@/lib/connection";
import type { TaskSection } from "@/lib/task-notices";
import type { TaskDetails as Details } from "@/lib/use-task-details";
import { SharedFiles } from "./SharedFiles.tsx";
import { TaskIncludedFiles } from "./TaskIncludedFiles.tsx";
import { TaskMergeRequest } from "./TaskMergeRequest.tsx";
import { TaskMessages } from "./TaskMessages.tsx";
import { TaskMiseConfig } from "./TaskMiseConfig.tsx";
import { TaskMiseRuns } from "./TaskMiseRuns.tsx";
import { TaskService } from "./TaskService.tsx";
import { TaskSummary } from "./TaskSummary.tsx";
import { TaskVerification } from "./TaskVerification.tsx";

/** The attribute a notice uses to find its section (`scrollToSection`). */
const SECTION_ATTRIBUTE = "data-task-section";

/**
 * The sections above a task's terminal (ADR-91), the same in the task panel and in a grid tile's overlay: the files
 * copied into the worktree (ADR-61), the warnings about shared files (ADR-44) and a changed mise config (ADR-59), the
 * messages from the proposer (ADR-68), the summary (ADR-39), the verification (ADR-64), the way to a merge request
 * (ADR-77), the service on the repo's port (ADR-132) and the mise tasks the agent runs in the worktree. Each section hides itself when it has nothing to show.
 */
export function TaskDetails({
  conn,
  task,
  details,
  sessions,
  onOpenTask,
  only,
}: {
  conn: Connection;
  task: Task;
  details: Details;
  sessions: readonly Session[];
  onOpenTask: (id: string) => void;
  /** One section alone, the others hidden rather than unmounted, so that they keep what the user did in them. */
  only?: TaskSection;
}) {
  return (
    <>
      <Section id="included" only={only}>
        <TaskIncludedFiles included={task.included} />
      </Section>
      <Section id="shared-files" only={only}>
        <SharedFiles shared={details.sharedFiles} onOpenTask={onOpenTask} />
      </Section>
      <Section id="mise-config" only={only}>
        <TaskMiseConfig conn={conn} task={task.id} remote={details.miseConfig} />
      </Section>
      <Section id="messages" only={only}>
        <TaskMessages messages={details.messages} sessions={sessions} />
      </Section>
      <Section id="summary" only={only}>
        {task.summary && <TaskSummary summary={task.summary} />}
      </Section>
      <Section id="verification" only={only}>
        <TaskVerification conn={conn} state={details.verification} />
      </Section>
      <Section id="merge-request" only={only}>
        <TaskMergeRequest conn={conn} task={task} verification={details.verification.verification} state={details.mergeRequest} />
      </Section>
      <Section id="service" only={only}>
        <TaskService conn={conn} task={task} />
      </Section>
      <Section id="mise-runs" only={only}>
        <TaskMiseRuns conn={conn} runs={details.miseRuns} />
      </Section>
    </>
  );
}

function Section({ id, only, children }: { id: TaskSection; only: TaskSection | undefined; children: ReactNode }) {
  return (
    <div {...{ [SECTION_ATTRIBUTE]: id }} hidden={only !== undefined && only !== id}>
      {children}
    </div>
  );
}

/** Brings a section into view inside its scrolling container, once it has rendered. */
export function scrollToSection(container: HTMLElement | null, section: TaskSection): void {
  requestAnimationFrame(() => container?.querySelector(`[${SECTION_ATTRIBUTE}="${section}"]`)?.scrollIntoView({ block: "nearest" }));
}
