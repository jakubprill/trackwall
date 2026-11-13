import { type TaskTemplateEntry, taskTemplatesApi, trackwallDirLabel } from "@trackwall/protocol";
import { BookmarkPlus } from "lucide-react";
import { type RefObject, useCallback, useRef, useState } from "react";
import { ErrorWithRetry } from "@/components/ErrorWithRetry";
import { RemoveForGood } from "@/components/RemoveForGood";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { post } from "@/lib/api";
import type { Connection } from "@/lib/connection";
import { type PromptSelection, placeholdersLeft, promptWithTemplate, templateSave } from "@/lib/task-template";
import { useAction } from "@/lib/use-action";
import { useRemote } from "@/lib/use-remote";

/**
 * Task templates above the New task form's prompt (ADR-251): one click fills the prompt from a template, built-in or the
 * user's own, and "Save as template" keeps the prompt as one of the user's own. The template last picked, when it is the
 * user's own, can be removed here. Nothing starts until the user presses the form's own button.
 */
export function TaskTemplatePicker({
  conn,
  prompt,
  picked,
  disabled,
  onPick,
  onPickedChange,
}: {
  conn: Connection;
  prompt: string;
  /** The template the prompt was last filled from, `null` before any. */
  picked: TaskTemplateEntry | null;
  disabled: boolean;
  /** Fills the prompt from the template. */
  onPick: (template: TaskTemplateEntry) => void;
  /** Names the template the prompt now is, without changing the prompt: the one just saved, or none after a removal. */
  onPickedChange: (template: TaskTemplateEntry | null) => void;
}) {
  const load = useCallback(() => post(conn, taskTemplatesApi.list, {}), [conn]);
  const list = useRemote(load);
  const [saving, setSaving] = useState(false);
  if (list.error) return <ErrorWithRetry message={list.error} onRetry={list.reload} />;
  if (!list.data) return null;
  const { templates, problems } = list.data;
  return (
    <section aria-label="Task templates" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-muted-foreground text-xs">Start from a template:</span>
        {templates.map((template) => (
          <Button
            key={template.name}
            variant={picked?.name === template.name ? "secondary" : "outline"}
            size="sm"
            disabled={disabled}
            title={template.origin === "own" ? `Your template, ${trackwallDirLabel("task-templates")}/${template.name}.md` : undefined}
            onClick={() => onPick(template)}
          >
            {template.title}
            {template.origin === "own" && <span className="text-muted-foreground"> · yours</span>}
          </Button>
        ))}
        {!saving && (
          <Button variant="ghost" size="sm" disabled={disabled || prompt.trim() === ""} onClick={() => setSaving(true)}>
            <BookmarkPlus /> Save as template
          </Button>
        )}
      </div>
      {saving && (
        <SaveTemplate
          conn={conn}
          prompt={prompt}
          templates={templates}
          suggestedTitle={picked?.title ?? ""}
          onClose={() => setSaving(false)}
          onSaved={(saved) => {
            setSaving(false);
            list.reload();
            onPickedChange(saved);
          }}
        />
      )}
      {picked?.origin === "own" && !saving && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">Your template “{picked.title}”</span>
          <RemoveForGood
            remove={() => post(conn, taskTemplatesApi.remove, { name: picked.name })}
            disabled={disabled}
            onRemoved={() => {
              onPickedChange(null);
              list.reload();
            }}
          />
        </div>
      )}
      {problems.map((problem) => (
        <p key={problem.file} className="text-destructive text-xs">
          <span className="font-mono">
            {trackwallDirLabel("task-templates")}/{problem.file}
          </span>
          : {problem.message}
        </p>
      ))}
    </section>
  );
}

/** The title to save the prompt under, and what that title would replace. */
function SaveTemplate({
  conn,
  prompt,
  templates,
  suggestedTitle,
  onClose,
  onSaved,
}: {
  conn: Connection;
  prompt: string;
  templates: readonly TaskTemplateEntry[];
  suggestedTitle: string;
  onClose: () => void;
  onSaved: (saved: TaskTemplateEntry) => void;
}) {
  const [title, setTitle] = useState(suggestedTitle);
  const save = useAction(() => post(conn, taskTemplatesApi.save, { title, prompt }), onSaved);
  const target = templateSave(title, templates);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Template title"
          placeholder="Template title, e.g. “Check a Flyway migration”"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="w-80"
        />
        <Button size="sm" disabled={save.pending || target.kind === "needs-title"} onClick={() => save.run()}>
          {target.kind === "replaces" ? "Replace template" : "Save template"}
        </Button>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Cancel
        </Button>
      </div>
      {target.kind === "replaces" && (
        <p className="text-muted-foreground text-xs">
          {target.template.origin === "built-in"
            ? `Your version takes the place of the built-in “${target.template.title}”; removing yours brings it back.`
            : `This replaces your template “${target.template.title}”.`}
        </p>
      )}
      {save.error && <p className="text-destructive text-xs">{save.error}</p>}
    </div>
  );
}

/** The template's placeholders the prompt still holds, as a reminder; the task can start anyway. */
export function TemplatePlaceholders({ prompt, picked }: { prompt: string; picked: TaskTemplateEntry | null }) {
  const left = placeholdersLeft(prompt, picked?.prompt ?? null);
  if (left.length === 0) return null;
  return (
    <p className="text-muted-foreground text-xs">Fill in {left.map((placeholder) => `“${placeholder}”`).join(", ")} before you start.</p>
  );
}

/**
 * The prompt filled from a task template (ADR-251): picking one sets the prompt (`promptWithTemplate`) and, once the
 * box shows it, selects its first placeholder so the user types over it.
 */
export function useTemplatePrompt(prompt: string, setPrompt: (prompt: string) => void) {
  const promptBox = useRef<HTMLTextAreaElement>(null);
  const [picked, setPicked] = useState<TaskTemplateEntry | null>(null);
  const pick = (template: TaskTemplateEntry) => {
    const next = promptWithTemplate(prompt, picked?.prompt ?? null, template.prompt);
    setPrompt(next.prompt);
    setPicked(template);
    selectAfterRender(promptBox, next.selection);
  };
  return { promptBox, picked, setPicked, pick };
}

/** Focuses the box after React has written the new value into it, selecting `selection` where there is one. */
function selectAfterRender(box: RefObject<HTMLTextAreaElement | null>, selection: PromptSelection | null) {
  window.requestAnimationFrame(() => {
    const element = box.current;
    if (!element) return;
    element.focus();
    if (selection) element.setSelectionRange(selection.start, selection.end);
  });
}
