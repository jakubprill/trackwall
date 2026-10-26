import type { ReactNode } from "react";
import { ErrorBoundary } from "@/components/ErrorBoundary";

/**
 * An error boundary around the formatted README (ADR-35): when the Streamdown bundle cannot be loaded (for example a
 * window from before a daemon update) or the README breaks rendering, the tab shows the raw text instead of an empty window.
 */
export function ReadmeFallback({ text, children }: { text: string; children: ReactNode }) {
  return (
    <ErrorBoundary
      fallback={(message) => (
        <div className="flex flex-col">
          <p className="text-muted-foreground border-b px-4 py-2 text-xs">Could not format the README ({message}); showing plain text.</p>
          <PlainReadme text={text} />
        </div>
      )}
    >
      {children}
    </ErrorBoundary>
  );
}

export function PlainReadme({ text }: { text: string }) {
  return <pre className="overflow-x-auto p-4 text-sm leading-relaxed whitespace-pre-wrap break-words">{text}</pre>;
}
