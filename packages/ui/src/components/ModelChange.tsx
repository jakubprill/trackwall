import { agentsApi, type Session, TASK_MODEL_MAX } from "@trackwall/protocol";
import { Bot } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { ProviderModelOptions } from "@/components/ProviderModelOptions";
import { UnofferedModelNote } from "@/components/UnofferedModelNote";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { restartOnModelNote } from "@/lib/model-change";
import { typedModel } from "@/lib/task-model";
import { useAction } from "@/lib/use-action";
import { useProviderModels } from "@/lib/use-provider-models";

/**
 * Another model for a running session or a task (ADR-206): Copilot CLI with a custom provider knows only the model it
 * started on, so the only way to another one is a restart on it with the same conversation, or a Resume of a stopped
 * task. The strip under the panel's header names the model now, suggests the provider's models and warns about an id it
 * does not offer; an empty field is Copilot CLI's default.
 */
export function ModelChangeStrip({
  conn,
  current,
  verb,
  note,
  apply,
  onDone,
  onCancel,
}: {
  conn: Connection;
  current: string | null;
  /** What the button does: a running session restarts, a stopped task resumes. */
  verb: "Restart" | "Resume";
  /** What the change does to this session or task, under the field. */
  note: string;
  apply: (model: string | null) => Promise<unknown>;
  onDone: () => void;
  onCancel: () => void;
}) {
  const listId = useId();
  const [text, setText] = useState(current ?? "");
  const { models } = useProviderModels(conn);
  const change = useAction(apply, onDone);
  const model = typedModel(text);
  function submit(e: FormEvent) {
    e.preventDefault();
    if (model !== undefined) change.run(model);
  }
  return (
    <form onSubmit={submit} aria-label="Change the model" className="bg-card flex flex-col gap-2 border-b px-4 py-2 text-xs">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Bot className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
        <span className="text-muted-foreground shrink-0">Model</span>
        <Input
          aria-label="Model for the agent"
          aria-invalid={model === undefined}
          className="h-7 w-56 font-mono text-xs"
          placeholder="Copilot CLI default"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={TASK_MODEL_MAX}
          spellCheck={false}
          autoFocus
          list={models.length > 0 ? listId : undefined}
        />
        {models.length > 0 && <ProviderModelOptions id={listId} models={models} />}
        <Button type="submit" size="sm" disabled={change.pending || model === undefined || model === current}>
          {verb} on this model
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={change.pending}>
          Cancel
        </Button>
      </div>
      {model === undefined && <span className="text-destructive">A model id, such as claude-opus-5.5</span>}
      <UnofferedModelNote typed={text} models={models} onPick={setText} />
      {change.error && <span className="text-destructive break-words">{change.error}</span>}
      <span className="text-muted-foreground">{note}</span>
    </form>
  );
}

/** The strip for a running session: a restart on the model, which the daemon keeps for the session, its task or the supervisor. */
export function SessionModelChange({
  conn,
  session,
  onDone,
  onCancel,
}: {
  conn: Connection;
  session: Session;
  onDone: () => void;
  onCancel: () => void;
}) {
  return (
    <ModelChangeStrip
      conn={conn}
      current={session.model}
      verb="Restart"
      note={restartOnModelNote(session)}
      apply={(model) => post(conn, agentsApi.restart, { session: session.id, model })}
      onDone={onDone}
      onCancel={onCancel}
    />
  );
}

/** The button that opens and closes the strip, in a panel's header: with its label, or as an icon in a narrow one. */
export function ModelChangeButton({
  open,
  onToggle,
  title,
  iconOnly = false,
  disabled = false,
}: {
  open: boolean;
  onToggle: () => void;
  title: string;
  iconOnly?: boolean;
  disabled?: boolean;
}) {
  return (
    <Button
      variant={iconOnly ? "ghost" : "outline"}
      size={iconOnly ? "icon" : "sm"}
      onClick={onToggle}
      disabled={disabled}
      aria-expanded={open}
      aria-label={iconOnly ? title : undefined}
      title={title}
    >
      <Bot />
      {!iconOnly && "Model"}
    </Button>
  );
}
