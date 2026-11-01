import { MiseRunArguments } from "@trackwall/protocol";

/**
 * The arguments of a mise task run as the user types them next to "Run" (ADR-158): words separated by spaces, since an
 * argument has no space in it. Checked with the daemon's schema, so a bad word is named before the run is sent. Pure,
 * tested in `test/mise-run-arguments.test.ts`.
 */
export function parseRunArguments(text: string): { ok: true; args: MiseRunArguments } | { ok: false; error: string } {
  const words = text.split(/\s+/).filter((word) => word !== "");
  const parsed = MiseRunArguments.safeParse(words);
  if (parsed.success) return { ok: true, args: parsed.data };
  const issue = parsed.error.issues[0];
  const word = typeof issue?.path[0] === "number" ? words[issue.path[0]] : undefined;
  return { ok: false, error: word === undefined ? (issue?.message ?? "invalid arguments") : `"${word}": ${issue?.message}` };
}
