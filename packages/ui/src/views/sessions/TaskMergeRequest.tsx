import {
  ExternalLink,
  type HostedProject,
  MERGE_REQUEST_DESCRIPTION_MAX,
  MERGE_REQUEST_TITLE_MAX,
  type MergeRequest,
  type TaskMergeRequest as State,
  type Task,
  type Verification,
} from "@trackwall/protocol";
import { GitPullRequestArrow, Upload } from "lucide-react";
import { useState } from "react";
import { StatusLabel } from "@/components/StatusLabel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { useOpenWebLink } from "@/lib/desktop";
import {
  branchPushLabel,
  canPush,
  hostLabel,
  type MergeRequestDraftText,
  mergeRequestDraft,
  mergeRequestNumber,
  mergeRequestStateLabel,
  pipelineLabel,
} from "@/lib/merge-request";
import type { TaskMergeRequestState } from "@/lib/use-task-merge-request";

/**
 * A finished task on its way to a merge request (ADR-77), below the verification: the task branch against the remote
 * with "Push", then the draft the user approves for the repo host's form (title and description from the task and its
 * verification), and once the merge request exists, its state and pipeline with links to them. The section shows only
 * once the task has a commit, since there is nothing to push before.
 */
export function TaskMergeRequest({
  conn,
  task,
  verification,
  state: { state, push, pushing, openForm, opening, error },
}: {
  conn: Connection;
  task: Task;
  verification: Verification | null;
  state: TaskMergeRequestState;
}) {
  const [draft, setDraft] = useState<MergeRequestDraftText>();
  if (!state?.push || state.push.commits === 0)
    return error ? <p className="text-destructive border-b px-4 py-2 text-xs">{error}</p> : null;
  const branch = state.push;
  const found = state.lookup?.kind === "found" ? state.lookup.mergeRequest : undefined;
  const formReady = state.project !== null && branch.published && branch.unpushed === 0 && found?.state !== "open";
  return (
    <section aria-label="Merge request" className="flex flex-col gap-2 border-b px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="hud-label">Merge request</span>
        <span className="text-muted-foreground flex-1 truncate text-xs">{`${branch.remote} · ${branchPushLabel(branch)}`}</span>
        {error && <span className="text-destructive max-w-xs truncate text-xs">{error}</span>}
        <Button variant="outline" size="sm" onClick={push} disabled={pushing || !canPush(branch)}>
          <Upload /> {pushing ? "Pushing…" : "Push"}
        </Button>
        {formReady && state.project && !draft && (
          <Button variant="outline" size="sm" onClick={() => setDraft(mergeRequestDraft(task, verification))}>
            <GitPullRequestArrow /> Open merge request
          </Button>
        )}
      </div>
      {found && state.project && <FoundMergeRequest conn={conn} project={state.project} mergeRequest={found} />}
      <HostNote state={state} />
      {draft && formReady && state.project && (
        <DraftForm
          project={state.project}
          target={state.targetBranch}
          draft={draft}
          onChange={setDraft}
          onOpen={() => openForm(draft)}
          onCancel={() => setDraft(undefined)}
          opening={opening}
        />
      )}
    </section>
  );
}

/** Why the panel cannot follow the merge request, when it cannot: no known repo host, or `gh` / `glab` did not answer. */
function HostNote({ state }: { state: State }) {
  if (state.project === null)
    return (
      <p className="text-muted-foreground text-xs">
        The remote is not on GitHub or on a repo host from Settings: add its repo host there to open the merge request from here.
      </p>
    );
  if (state.lookup?.kind === "unavailable")
    return <p className="text-muted-foreground text-xs">{`Cannot read the merge request: ${state.lookup.message}`}</p>;
  return null;
}

function FoundMergeRequest({ conn, project, mergeRequest }: { conn: Connection; project: HostedProject; mergeRequest: MergeRequest }) {
  const [linkError, setLinkError] = useState<string>();
  const openLink = useOpenWebLink(conn);
  const open = (url: string) => {
    const link = ExternalLink.safeParse(url);
    if (!link.success) return setLinkError("the repo host gave an address Trackwall does not open");
    openLink(link.data).catch((err: unknown) => setLinkError(errorMessage(err)));
  };
  const { pipeline } = mergeRequest;
  return (
    <div className="flex min-w-0 items-center gap-3 text-xs">
      <Button
        variant="ghost"
        size="sm"
        className="h-auto min-w-0 p-0 underline-offset-4 hover:underline"
        onClick={() => open(mergeRequest.url)}
        title={mergeRequest.url}
      >
        <span className="truncate">{`${mergeRequestNumber(project, mergeRequest.number)} ${mergeRequest.title}`}</span>
      </Button>
      <StatusLabel {...mergeRequestStateLabel(mergeRequest.state)} />
      {pipeline ? (
        <Button variant="ghost" size="sm" className="h-auto p-0" onClick={() => open(pipeline.url)} title={pipeline.url}>
          <StatusLabel {...pipelineLabel(pipeline.state)} />
        </Button>
      ) : (
        <span className="text-muted-foreground">no pipeline</span>
      )}
      {linkError && <span className="text-destructive truncate">{linkError}</span>}
    </div>
  );
}

/** The title and description the user approves; the rest (reviewers, labels, a draft) they set in the repo host's form. */
function DraftForm({
  project,
  target,
  draft,
  onChange,
  onOpen,
  onCancel,
  opening,
}: {
  project: HostedProject;
  target: string | null;
  draft: MergeRequestDraftText;
  onChange: (draft: MergeRequestDraftText) => void;
  onOpen: () => void;
  onCancel: () => void;
  opening: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Input
        aria-label="Merge request title"
        value={draft.title}
        maxLength={MERGE_REQUEST_TITLE_MAX}
        onChange={(e) => onChange({ ...draft, title: e.target.value })}
      />
      <Textarea
        aria-label="Merge request description"
        className="max-h-48 font-mono text-xs"
        rows={6}
        value={draft.description}
        maxLength={MERGE_REQUEST_DESCRIPTION_MAX}
        onChange={(e) => onChange({ ...draft, description: e.target.value })}
      />
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground flex-1 text-xs">
          {`Into ${target ?? "the default branch"}. ${hostLabel(project)} opens with these fields filled in; you create the merge request there.`}
        </span>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={onOpen} disabled={opening || draft.title.trim() === ""}>
          {`Open in ${hostLabel(project)}`}
        </Button>
      </div>
    </div>
  );
}
