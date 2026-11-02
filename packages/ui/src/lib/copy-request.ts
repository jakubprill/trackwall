/**
 * How long Copy waits after a copy request appears or changes (ADR-180): an agent that keeps replacing its request
 * cannot swap the text under the user's click, since Copy is never ready for text the user had no second to read.
 */
export const COPY_REQUEST_HOLD_MS = 1000;

/**
 * Whether Copy is ready: the strip notes the request's id once `COPY_REQUEST_HOLD_MS` have passed since it showed that
 * id (`readyFor`). Keyed on the id, never the object, because the session list brings a new object with every update.
 */
export function copyReady(readyFor: string | undefined, request: { id: string } | null): boolean {
  return request !== null && readyFor === request.id;
}

/**
 * How the strip names the text before the user copies it (ADR-180): its first line that is not blank, and how many
 * lines and characters there are, so text the strip cuts off is not a surprise in the paste. The whole text is the
 * strip's tooltip.
 */
export function copyRequestPreview(text: string): { firstLine: string; lines: number; characters: number } {
  const lines = text.split(/\r\n|\r|\n/);
  const firstLine = lines.find((line) => line.trim() !== "")?.trim() ?? "";
  return { firstLine, lines: lines.length, characters: [...text].length };
}
