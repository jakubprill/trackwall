import { Button } from "@/components/ui/button";

/** An app-wide error in a strip above the view, with one action (try again, dismiss); nothing while there is no error. */
export function ErrorBanner({ message, action }: { message: string | undefined; action: { label: string; onClick: () => void } }) {
  if (message === undefined) return null;
  return (
    <div className="bg-destructive/10 flex items-center gap-3 border-b px-4 py-2">
      <p className="text-destructive min-w-0 flex-1 text-sm whitespace-pre-wrap">{message}</p>
      <Button variant="outline" size="sm" onClick={action.onClick}>
        {action.label}
      </Button>
    </div>
  );
}
