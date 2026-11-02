import type { CopyRequest, Session } from "@trackwall/protocol";

/** The copy request of a session that runs (ADR-180), for the strip in its panel; `null` hides it. */
export function shownCopyRequest(session: Session | undefined): CopyRequest | null {
  return session?.run.kind === "running" ? session.copyRequest : null;
}

/**
 * How the strip names the text before the user copies it: its first line that is not blank, and how many lines there
 * are, so a longer text than the strip shows is not a surprise in the paste. The whole text is the strip's tooltip.
 */
export function copyRequestPreview(text: string): { firstLine: string; lines: number } {
  const lines = text.split(/\r\n|\r|\n/);
  const firstLine = lines.find((line) => line.trim() !== "")?.trim() ?? "";
  return { firstLine, lines: lines.length };
}
