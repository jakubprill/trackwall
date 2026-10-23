import { BATCH_STEPS, type BatchRepo, type BatchStep, type Repo } from "@trackwall/protocol";
import { ListChecks, Play, Square } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Loading } from "@/components/Loading";
import { StatusLabel } from "@/components/StatusLabel";
import { Surface } from "@/components/Surface";
import { Button } from "@/components/ui/button";
import { batchProgress, batchRunLabel, STEP_HINT, STEP_LABEL, stepLabel, stepMessage } from "@/lib/batch-state";
import type { BatchRunHandle } from "@/lib/use-batch-run";

/**
 * Komenda zbiorcza (ADR-27): wybór kroków i repo, start, przerwanie i wynik każdego kroku w każdym repo. Repo
 * wybiera się ręcznie z listy repo; filtr po tagach dołoży tu zaznaczanie grupy repo.
 */
export function BatchView({ batch, repos }: { batch: BatchRunHandle; repos: readonly Repo[] }) {
  const [steps, setSteps] = useState<ReadonlySet<BatchStep>>(() => new Set(BATCH_STEPS));
  // Domyślnie wszystkie repo; repo, które pojawi się na liście później, nie jest zaznaczane samo.
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set(repos.map((r) => r.id)));
  const chosen = repos.filter((r) => selected.has(r.id));
  const { run } = batch;

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-col gap-1">
        <span className="hud-label">Komenda zbiorcza</span>
        <h1 className="text-xl font-semibold tracking-tight">Te same kroki na wielu repo naraz</h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          Kroki idą w repo po kolei, a repo po trzy naraz. Błąd kroku kończy to repo, pozostałe idą dalej. Taski mise z <code>sources</code>{" "}
          i <code>outputs</code> mise pomija, gdy nic się nie zmieniło, więc powtórka jest szybka.
        </p>
      </header>
      <Surface label="Kroki" meta={`${steps.size}/${BATCH_STEPS.length}`}>
        <ul className="divide-y">
          {BATCH_STEPS.map((step) => (
            <Choice key={step} checked={steps.has(step)} onChange={() => setSteps(toggle(steps, step))}>
              <span className="text-sm">{STEP_LABEL[step]}</span>
              <span className="text-muted-foreground text-xs">{STEP_HINT[step]}</span>
            </Choice>
          ))}
        </ul>
      </Surface>
      <Surface label="Repo" meta={`${chosen.length}/${repos.length}`}>
        <div className="flex gap-2 border-b px-3 py-2">
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set(repos.map((r) => r.id)))}>
            Wszystkie
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>
            Żadne
          </Button>
        </div>
        <ul className="divide-y">
          {repos.map((repo) => (
            <Choice key={repo.id} checked={selected.has(repo.id)} onChange={() => setSelected(toggle(selected, repo.id))}>
              <span className="truncate font-mono text-sm">{repo.id}</span>
            </Choice>
          ))}
        </ul>
      </Surface>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={batch.running || chosen.length === 0 || steps.size === 0}
          onClick={() => batch.start({ repos: chosen.map((r) => r.id), steps: BATCH_STEPS.filter((s) => steps.has(s)) })}
        >
          <Play /> Uruchom na {chosen.length} repo
        </Button>
        {run?.finishedAt === null && (
          <Button variant="outline" size="sm" disabled={run.cancelled} onClick={batch.cancel}>
            <Square /> {run.cancelled ? "Przerywam…" : "Przerwij"}
          </Button>
        )}
      </div>
      {batch.error && <p className="text-destructive text-sm whitespace-pre-wrap break-words">{batch.error}</p>}
      {run === undefined && !batch.error && <Loading />}
      {run && <Results run={run} />}
    </div>
  );
}

/** Pod listą repo: przejście do komendy zbiorczej, z postępem, gdy trwa. */
export function BatchBar({ batch, onShow }: { batch: BatchRunHandle; onShow: () => void }) {
  const progress = batch.run?.finishedAt === null ? batchProgress(batch.run) : undefined;
  return (
    <div className="flex px-4 pb-3">
      <Button variant="outline" size="sm" onClick={onShow}>
        <ListChecks /> {progress ? `Komenda zbiorcza ${progress.done}/${progress.total}` : "Komenda zbiorcza"}
      </Button>
    </div>
  );
}

function Results({ run }: { run: NonNullable<BatchRunHandle["run"]> }) {
  const progress = batchProgress(run);
  return (
    <Surface
      label={batchRunLabel(run, new Date())}
      meta={`${progress.done}/${progress.total}`}
      note={progress.failed > 0 ? `Repo z błędem: ${progress.failed}` : undefined}
    >
      <ul className="divide-y">
        {run.repos.map((repo) => (
          <ResultRow key={repo.path} repo={repo} />
        ))}
      </ul>
    </Surface>
  );
}

function ResultRow({ repo }: { repo: BatchRepo }) {
  return (
    <li className="flex flex-col gap-2 px-3 py-2">
      <span className="truncate font-mono text-sm" title={repo.path}>
        {repo.repo}
      </span>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {repo.steps.map((step) => {
          const { tone, label } = stepLabel(step);
          return (
            <span key={step.step} className="flex items-center gap-2" title={stepMessage(step)}>
              <span className="text-muted-foreground">{STEP_LABEL[step.step]}</span>
              {tone ? <StatusLabel tone={tone} label={label} /> : <span>{label}</span>}
            </span>
          );
        })}
      </div>
      {repo.steps.map((step) =>
        step.state === "failed" ? (
          <div key={step.step} className="flex flex-col gap-1">
            <span className="text-destructive text-xs whitespace-pre-wrap break-words">
              {STEP_LABEL[step.step]}: {step.message}
            </span>
            {step.lastLines.length > 0 && (
              <pre className="text-muted-foreground overflow-x-auto font-mono text-xs whitespace-pre-wrap break-all">
                {step.lastLines.join("\n")}
              </pre>
            )}
          </div>
        ) : null,
      )}
    </li>
  );
}

function Choice({ checked, onChange, children }: { checked: boolean; onChange: () => void; children: ReactNode }) {
  return (
    <li>
      <label className="hover:bg-accent flex cursor-pointer items-center gap-3 px-3 py-2">
        <input type="checkbox" className="accent-primary size-4 shrink-0" checked={checked} onChange={onChange} />
        <span className="flex min-w-0 flex-col">{children}</span>
      </label>
    </li>
  );
}

function toggle<T>(set: ReadonlySet<T>, item: T): ReadonlySet<T> {
  const next = new Set(set);
  if (!next.delete(item)) next.add(item);
  return next;
}
