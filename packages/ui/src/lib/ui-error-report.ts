import { errorJournalApi, type UiErrorPage, type UiErrorReport, UiErrorReport as UiErrorReportSchema } from "@trackwall/protocol";
import { post } from "./api.ts";
import { resolveConnection } from "./connection.ts";

/**
 * The UI's errors into the daemon's error journal (ADR-94): what React caught in a boundary or nobody caught, an error
 * `window.onerror` sees and a rejected promise nobody handled. The page sends the error's name, message and stack as the
 * browser wrote them; the daemon maps the frames to the UI's sources and anonymizes the text. A failed send is dropped:
 * reporting must never be another error. The same error within a minute is sent once, and at most `MAX_PER_MINUTE` in all,
 * so an error in a render loop cannot flood the daemon.
 */

const MAX_PER_MINUTE = 20;
const MINUTE_MS = 60_000;

/** The report of an error as the daemon's schema takes it: every field cut to its limit. */
export function uiErrorReport(error: unknown, page: UiErrorPage): UiErrorReport {
  const shape = UiErrorReportSchema.shape;
  const err = error instanceof Error ? error : new Error(typeof error === "string" ? error : "a value that is not an Error was thrown");
  return {
    page,
    name: cut(err.name || "Error", shape.name.maxLength),
    message: cut(err.message, shape.message.maxLength),
    stack: cut(err.stack ?? "", shape.stack.maxLength),
  };
}

function cut(text: string, max: number | null): string {
  return max !== null && text.length > max ? text.slice(0, max) : text;
}

/** Which reports go out: one per error per minute, at most `MAX_PER_MINUTE` a minute. */
export class UiErrorGate {
  private readonly sent = new Map<string, number>();

  allow(report: UiErrorReport, nowMs: number): boolean {
    for (const [key, at] of this.sent) if (nowMs - at >= MINUTE_MS) this.sent.delete(key);
    const key = `${report.name}\n${report.message}\n${report.stack.split("\n", 2)[1] ?? ""}`;
    if (this.sent.has(key) || this.sent.size >= MAX_PER_MINUTE) return false;
    this.sent.set(key, nowMs);
    return true;
  }
}

/**
 * Starts reporting the page's errors and gives the root's error handlers for `createRoot`. React logs a caught error itself
 * only without its own handlers, so the handlers log it too.
 */
export function reportUiErrors(page: UiErrorPage): {
  onCaughtError: (error: unknown) => void;
  onUncaughtError: (error: unknown) => void;
} {
  const gate = new UiErrorGate();
  const report = (error: unknown) => {
    const body = uiErrorReport(error, page);
    if (!gate.allow(body, Date.now())) return;
    resolveConnection()
      .then((conn) => post(conn, errorJournalApi.recordUiError, body))
      .catch(() => {});
  };
  window.addEventListener("error", (event) => report(event.error ?? event.message));
  window.addEventListener("unhandledrejection", (event) => report(event.reason));
  const logAndReport = (error: unknown) => {
    console.error(error);
    report(error);
  };
  return { onCaughtError: logAndReport, onUncaughtError: logAndReport };
}
