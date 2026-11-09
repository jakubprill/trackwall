import { workspaceApi } from "@trackwall/protocol";
import { useCallback } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { Loading } from "@/components/Loading";
import { Surface } from "@/components/Surface";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { parseTokenBudget } from "@/lib/token-budget";
import { useRemote } from "@/lib/use-remote";
import { PathForm } from "./PathForm.tsx";

const LABEL = "Token budget per task";

/**
 * The task token budget (ADR-237): how many tokens a task's session may use from its start or resume before Trackwall
 * stops it, so a task left alone cannot run up the bill. Typed as `2M` or `500k`, saved as a number in `workspace.yaml`.
 */
export function TaskTokenBudgetSurface({ conn }: { conn: Connection }) {
  const load = useCallback(() => post(conn, workspaceApi.settings, {}), [conn]);
  const settings = useRemote(load);

  async function save(budget: number | null) {
    await post(conn, workspaceApi.setTaskTokenBudget, { budget });
    settings.reload();
  }

  async function saveTyped(text: string) {
    const parsed = parseTokenBudget(text);
    if ("problem" in parsed) throw new Error(parsed.problem);
    await save(parsed.budget);
  }

  const data = settings.data;
  return (
    <Surface label={LABEL}>
      <div className="flex flex-col gap-4 p-4">
        <p className="text-muted-foreground text-sm">
          How many tokens (in and out) a task may use from its start or resume. When it reaches them, Trackwall stops the task as Stop does,
          and Resume gives it the budget again. It counts tokens, not AI credits, so it works with a model of your own provider too. A
          change applies from the next start or resume. Without it, tasks have no limit.
        </p>
        {settings.error && <ErrorWithRetry message={settings.error} onRetry={settings.reload} />}
        {!data && !settings.error && <Loading />}
        {data && (
          <PathForm
            key={data.taskTokenBudget ?? ""}
            label={LABEL}
            placeholder="2M"
            configKey="taskTokenBudget"
            initialPath={data.taskTokenBudget === null ? "" : String(data.taskTokenBudget)}
            configFile={data.configFile}
            folder={false}
            save={saveTyped}
            resetLabel="No budget"
            reset={data.taskTokenBudget === null && !data.taskTokenBudgetProblem ? undefined : () => save(null)}
          />
        )}
        {data?.taskTokenBudgetProblem && <p className="text-destructive text-xs break-words">{data.taskTokenBudgetProblem}</p>}
      </div>
    </Surface>
  );
}
