import { JOB_LOG_CHARS_MAX, JOB_LOG_LINES_MAX } from "@trackwall/protocol";
import { maskSecrets } from "./secret-mask.ts";
import { stripAnsi, visibleText } from "./stream-lines.ts";

/**
 * The end of a CI job's log from a repo host (§4.12, ADR-195), cleaned and masked like a line of the log buffer before
 * the UI or an agent sees it. A job says why it failed at its end, so the excerpt is its last lines.
 */

/** GitLab's collapsible sections: `section_start:<time>:<name>[<options>]` up to the `\r` that ends the marker. */
const GITLAB_SECTION = /section_(start|end):\d+:[^\r\n]*?\r/g;
/** The timestamp GitHub Actions puts before every line of a job's log. */
const GITHUB_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z ?/;

export interface JobLogExcerpt {
  text: string;
  /** Earlier lines were left out; with no text, the log was longer than the daemon reads. */
  truncated: boolean;
}

/**
 * The last `JOB_LOG_LINES_MAX` lines of `raw`, at most `JOB_LOG_CHARS_MAX` characters, without colours, section markers,
 * timestamps and overwritten progress, each line masked with `secrets` (`secretValues`). `cut` says the answer itself
 * ended before the log did: its last lines are then not the job's, so there is no excerpt, only `truncated`.
 */
export function jobLogExcerpt(raw: string, secrets: readonly string[], cut = false): JobLogExcerpt {
  if (cut) return { text: "", truncated: true };
  const lines = stripAnsi(raw)
    .split("\n")
    .flatMap((line) => {
      const unmarked = line.replace(GITLAB_SECTION, "");
      const text = visibleText(maskSecrets(unmarked.replace(GITHUB_TIMESTAMP, ""), secrets));
      // A line that only marked where a section ends is not a line of the job's output.
      return text === "" && unmarked !== line ? [] : [text];
    });
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const kept: string[] = [];
  let chars = 0;
  let sliced = false;
  for (let i = lines.length - 1; i >= 0 && kept.length < JOB_LOG_LINES_MAX; i--) {
    const line = lines[i] ?? "";
    if (chars + line.length + 1 > JOB_LOG_CHARS_MAX) {
      // A last line longer than the whole excerpt still shows its end, so the excerpt is never empty.
      if (kept.length === 0) {
        kept.push(line.slice(line.length - JOB_LOG_CHARS_MAX));
        sliced = true;
      }
      break;
    }
    kept.push(line);
    chars += line.length + 1;
  }
  kept.reverse();
  return { text: kept.join("\n"), truncated: sliced || kept.length < lines.length };
}
