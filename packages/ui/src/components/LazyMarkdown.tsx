import { lazy } from "react";

/**
 * `Markdown` loaded on first use: Streamdown with Mermaid is a few MB, which the rest of the UI does not need. A caller
 * wraps it in `Suspense` and an error boundary with the plain text, for the load and for a rendering error (ADR-35).
 */
export const LazyMarkdown = lazy(() => import("@/components/Markdown").then((m) => ({ default: m.Markdown })));
