import { Component, type ReactNode } from "react";
import { errorMessage } from "@/lib/api";

interface ErrorBoundaryProps {
  /** What shows instead of `children` after an error; `retry` mounts `children` again. */
  fallback: (message: string, retry: () => void) => ReactNode;
  /** Told once per error, after the fallback has replaced `children`. */
  onError?: (message: string) => void;
  children: ReactNode;
}

/**
 * Keeps an error thrown while rendering a part of the window (or in its effects, or by a lazily loaded chunk) inside that
 * part. Without a boundary React unmounts the whole root, and the window goes blank: one broken view, or the 3D scene in
 * a WebView that refuses it, would take the view bar and every other view with it.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, { error?: string }> {
  override state: { error?: string } = {};

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: errorMessage(error) };
  }

  // React logs the error itself.
  override componentDidCatch(error: unknown) {
    this.props.onError?.(errorMessage(error));
  }

  override render() {
    if (this.state.error === undefined) return this.props.children;
    return this.props.fallback(this.state.error, () => this.setState({ error: undefined }));
  }
}
