/**
 * The button of a task's summary (ADR-39, ADR-169): "Show all" when two lines cut the text, "How to check" when only
 * the check steps are hidden, "Show less" once opened, and no button when everything already shows. The check steps
 * show only when opened, so the label is the one hint that they exist.
 */
export function summaryToggleLabel(open: boolean, cut: boolean, checkSteps: number): "Show all" | "How to check" | "Show less" | null {
  if (open) return "Show less";
  if (cut) return "Show all";
  return checkSteps > 0 ? "How to check" : null;
}
