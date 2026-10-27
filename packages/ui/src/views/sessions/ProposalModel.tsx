import { TASK_MODEL_MAX } from "@trackwall/protocol";
import { Input } from "@/components/ui/input";
import { typedModel } from "@/lib/proposal-decisions";

/**
 * A task proposal's model (ADR-98): the Copilot CLI model the proposer chose, which the user may change or clear before
 * the start. Empty is Copilot CLI's default model.
 */
export function ProposalModel({ title, value, onChange }: { title: string; value: string; onChange: (value: string) => void }) {
  const invalid = typedModel(value) === undefined;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground" aria-hidden>
        Model
      </span>
      <Input
        aria-label={`Model for the agent: ${title}`}
        aria-invalid={invalid}
        className="h-8 w-56 font-mono text-xs"
        placeholder="Copilot CLI default"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={TASK_MODEL_MAX}
        spellCheck={false}
      />
      {invalid && <span className="text-destructive">A model id, such as claude-opus-5.5, or empty for the default</span>}
    </div>
  );
}
