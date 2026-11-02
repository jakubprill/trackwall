import type { BrowserContext } from "playwright";

/**
 * Reports every Content-Security-Policy violation in the pages of a browser context, a tab opened later in it too: the browser fires `securitypolicyviolation` in the page
 * for each refusal, also one the UI survives with a fallback (a README or an answer as plain text), which a test that
 * only looks at the screen would not notice. Call it before a page of the context loads the UI.
 */
export async function onCspViolation(context: BrowserContext, report: (text: string) => void): Promise<void> {
  await context.exposeFunction("reportCspViolation", report);
  await context.addInitScript(reportCspViolations);
}

/** Runs in the page before its scripts. */
function reportCspViolations(): void {
  const report = (window as unknown as { reportCspViolation: (text: string) => void }).reportCspViolation;
  window.addEventListener("securitypolicyviolation", (event) =>
    report(`${event.effectiveDirective} refused ${event.blockedURI} at ${event.sourceFile}:${event.lineNumber}`),
  );
}
