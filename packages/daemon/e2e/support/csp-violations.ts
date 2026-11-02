import type { Page } from "playwright";

/**
 * Reports every Content-Security-Policy violation of a page: the browser fires `securitypolicyviolation` in the page
 * for each refusal, also one the UI survives with a fallback (a README or an answer as plain text), which a test that
 * only looks at the screen would not notice. Call it before the page loads the UI.
 */
export async function onCspViolation(page: Page, report: (text: string) => void): Promise<void> {
  await page.exposeFunction("reportCspViolation", report);
  await page.addInitScript(reportCspViolations);
}

/** Runs in the page before its scripts. */
function reportCspViolations(): void {
  const report = (window as unknown as { reportCspViolation: (text: string) => void }).reportCspViolation;
  window.addEventListener("securitypolicyviolation", (event) =>
    report(`${event.effectiveDirective} refused ${event.blockedURI} at ${event.sourceFile}:${event.lineNumber}`),
  );
}
