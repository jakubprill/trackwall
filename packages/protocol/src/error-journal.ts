import { z } from "zod";
import { apiEndpoints, Done } from "./api.ts";

/**
 * Contract of the `error-journal` module (ADR-94): Trackwall's own errors, from the daemon, the desktop shell and the UI, kept
 * on this computer with where in Trackwall's code they came from. Nothing leaves the computer; every text is anonymized
 * before it is saved. Every action is `POST /api/error-journal/<action>`.
 */

/** The part of Trackwall an error came from. */
export const TrackwallErrorSource = z.enum(["daemon", "shell", "ui"]);
export type TrackwallErrorSource = z.infer<typeof TrackwallErrorSource>;

/** The longest anonymized message the journal keeps; the start of an error says what it is. */
export const MAX_ERROR_MESSAGE_CHARS = 500;
/** The frames of one error, from the top of its stack. */
export const MAX_ERROR_FRAMES = 8;

/**
 * One error of Trackwall, the same error counted once: the same source, area, kind and top frame (`fingerprint`).
 * `frames` are places in Trackwall's own code as paths in its repo with a line (`packages/daemon/src/api/server.ts:68`);
 * frames of libraries are left out.
 */
export const TrackwallError = z.object({
  fingerprint: z.string(),
  source: TrackwallErrorSource,
  /** Where in Trackwall: an API action (`api:/api/workspace/sync`), an MCP tool (`mcp:get_repo`), a UI folder (`ui:views/repos`), a shell file (`shell:badge`). */
  area: z.string(),
  /** The error's class (`TypeError`), or what happened (`uncaught`, `panic`, `startup`). */
  kind: z.string(),
  message: z.string(),
  frames: z.array(z.string()),
  count: z.number().int().positive(),
  firstSeen: z.string(),
  lastSeen: z.string(),
  /** The Trackwall version that saw it last. */
  version: z.string(),
});
export type TrackwallError = z.infer<typeof TrackwallError>;

/** Newest first. */
export const ErrorJournal = z.object({ errors: z.array(TrackwallError) });
export type ErrorJournal = z.infer<typeof ErrorJournal>;

/** Where in the UI an error was caught; the daemon finds the area from the stack. */
export const UiErrorPage = z.enum(["window", "tray-panel"]);
export type UiErrorPage = z.infer<typeof UiErrorPage>;

/** An error the UI caught, with its stack as the browser wrote it; the daemon maps the frames to the UI's sources. */
export const UiErrorReport = z
  .object({
    page: UiErrorPage,
    name: z.string().max(200),
    message: z.string().max(4000),
    stack: z.string().max(20_000),
  })
  .strict();
export type UiErrorReport = z.infer<typeof UiErrorReport>;

const endpoint = apiEndpoints("error-journal");

const Empty = z.object({}).strict();

export const errorJournalApi = {
  /** The journal with the shell's errors read in, newest first. */
  errors: endpoint("errors", Empty, ErrorJournal),
  /** An error the UI caught (React, `window.onerror`, a rejected promise nobody handled). */
  recordUiError: endpoint("record-ui-error", UiErrorReport, Done),
  /** Empties the journal, the shell's errors included. */
  clear: endpoint("clear", Empty, Done),
};
