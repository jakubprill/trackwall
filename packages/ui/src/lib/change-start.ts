/**
 * What started of a change when some parts could not (ADR-171): the started parts are tasks now, which the user finds in
 * the list, so a form that says this does not offer to start them again.
 */
export function changeStartedPartly(started: readonly string[], failed: readonly { repo: string; message: string }[]): string {
  const lines = failed.map((f) => `${f.repo}: ${f.message}`);
  return `Started in ${started.join(", ")}; these parts could not start:\n${lines.join("\n")}`;
}
