import { Component, type ReactNode } from "react";

/**
 * An error boundary around the formatted README (ADR-35): when the Streamdown bundle cannot be loaded (for example a
 * window from before a daemon update) or the README breaks rendering, the tab shows the raw text instead of an empty window.
 */
export class ReadmeFallback extends Component<{ text: string; children: ReactNode }, { error?: string }> {
  override state: { error?: string } = {};

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  override render() {
    if (this.state.error === undefined) return this.props.children;
    return (
      <div className="flex flex-col">
        <p className="text-muted-foreground border-b px-4 py-2 text-xs">
          Could not format the README ({this.state.error}); showing plain text.
        </p>
        <PlainReadme text={this.props.text} />
      </div>
    );
  }
}

export function PlainReadme({ text }: { text: string }) {
  return <pre className="overflow-x-auto p-4 text-sm leading-relaxed whitespace-pre-wrap break-words">{text}</pre>;
}
