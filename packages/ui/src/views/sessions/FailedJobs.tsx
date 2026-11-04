import { type FailedJob, type JobLog, mergeRequestsApi } from "@trackwall/protocol";
import { ScrollText, Wrench } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { jobLogNote } from "@/lib/merge-request";
import { useAction } from "@/lib/use-action";

/**
 * The jobs that failed a task's merge request pipeline (ADR-154), each a link to its page, with the end of a job's log
 * read on request and "Fix", which hands the failed jobs' logs to the task's agent (ADR-195).
 */
export function FailedJobs({
  conn,
  task,
  jobs,
  open,
  fix,
}: {
  conn: Connection;
  task: string;
  jobs: readonly FailedJob[];
  open: (url: string) => void;
  /** `undefined` when the pipeline cannot be fixed from here (the merge request is not open). */
  fix?: { run: () => void; pending: boolean; sent: string | undefined };
}) {
  const [shown, setShown] = useState<JobLog>();
  const read = useAction((job: string) => post(conn, mergeRequestsApi.jobLog, { task, job }), setShown);
  const note = shown && jobLogNote(shown);
  const toggle = (id: string) => () => (shown?.job.id === id ? setShown(undefined) : read.run(id));
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-3 text-xs">
        <span>Failed:</span>
        {jobs.map((job, i) => (
          // A check and a commit status on GitHub can share a name.
          <span key={`${i}:${job.name}`} className="flex items-center gap-1">
            <JobName job={job} open={open} />
            {job.id !== null && (
              <JobLogToggle name={job.name} shown={shown?.job.id === job.id} disabled={read.pending} onClick={toggle(job.id)} />
            )}
          </span>
        ))}
        {fix && (
          <Button variant="outline" size="sm" className="ml-auto" onClick={fix.run} disabled={fix.pending}>
            <Wrench /> {fix.pending ? "Reading the logs…" : "Fix"}
          </Button>
        )}
      </div>
      {fix?.sent && <p className="text-muted-foreground text-xs">{fix.sent}</p>}
      {read.error && <p className="text-destructive text-xs">{read.error}</p>}
      {shown && (
        <section aria-label={`End of the log of ${shown.job.name}`} className="flex flex-col gap-1">
          {note && <p className="text-muted-foreground text-xs">{note}</p>}
          {shown.text !== "" && (
            <pre
              // The end is what says why the job failed.
              ref={(pre) => {
                if (pre) pre.scrollTop = pre.scrollHeight;
              }}
              className="bg-muted text-muted-foreground max-h-64 overflow-auto rounded-sm px-2 py-1 font-mono text-xs break-all whitespace-pre-wrap"
            >
              {shown.text}
            </pre>
          )}
        </section>
      )}
    </div>
  );
}

function JobName({ job, open }: { job: FailedJob; open: (url: string) => void }) {
  const { url } = job;
  if (url === null) return <span>{job.name}</span>;
  return (
    <Button variant="ghost" size="sm" className="h-auto p-0 underline-offset-4 hover:underline" onClick={() => open(url)} title={url}>
      {job.name}
    </Button>
  );
}

function JobLogToggle({ name, shown, disabled, onClick }: { name: string; shown: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-auto p-0"
      aria-label={`${shown ? "Hide" : "Show"} the log of ${name}`}
      aria-pressed={shown}
      title={shown ? "Hide the log" : "Show the end of its log"}
      disabled={disabled}
      onClick={onClick}
    >
      <ScrollText />
    </Button>
  );
}
