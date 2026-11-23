/** The words for a changed file or setting, shared by every review of changes before trust. */
export const CHANGE_LABEL = { added: "added", modified: "changed", removed: "deleted" } as const;

/**
 * One changed file or setting the user reads before trusting or accepting it: its label, and for one that is still
 * there its text folded under the label, or why the text is not shown.
 */
export function ChangedText({
  label,
  removed,
  content,
  notShown,
}: {
  label: string;
  removed: boolean;
  content: string | null;
  notShown: string;
}) {
  if (removed) return <p className="text-muted-foreground truncate font-mono text-xs">{label}</p>;
  return (
    <details className="text-xs">
      <summary className="text-muted-foreground cursor-pointer truncate font-mono">{label}</summary>
      {content === null ? (
        <p className="text-muted-foreground mt-1">{notShown}</p>
      ) : (
        <pre className="bg-background mt-1 max-h-64 overflow-auto rounded border p-2 font-mono whitespace-pre-wrap">{content}</pre>
      )}
    </details>
  );
}
