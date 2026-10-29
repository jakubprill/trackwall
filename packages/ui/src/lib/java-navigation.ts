import {
  JAVA_NAVIGATION_STALL_MS,
  JAVA_TAG,
  type JavaNavigationInstall,
  type JavaNavigationState,
  type JavaNavigationStatus,
  type RepoTag,
} from "@trackwall/protocol";
import type { StatusTone } from "./repo-status.ts";

/**
 * Whether the New session form offers Java navigation (ADR-99) for a task in a repo: only in a repo tagged `java`, and
 * there either ready or unavailable with the reason, so that the user sees the option and what it still needs.
 */
export type JavaNavigationOffer = { kind: "hidden" } | { kind: "ready" } | { kind: "unavailable"; reason: string };

export function javaNavigationOffer(tags: readonly RepoTag[] | undefined, state: JavaNavigationState | undefined): JavaNavigationOffer {
  if (!tags?.some((tag) => tag.name === JAVA_TAG) || state === undefined) return { kind: "hidden" };
  if (state === null)
    return {
      kind: "unavailable",
      reason: "Not set up yet: install it in Settings › Agents.",
    };
  if (state.problem !== null) return { kind: "unavailable", reason: `Cannot start: ${state.problem}.` };
  return { kind: "ready" };
}

/** The tone of the install's state line in Settings › Agents. */
export type JavaNavigationSetupTone = "muted" | "ok" | "error";

/**
 * What the Java navigation section of Settings says (ADR-123): a running install's step, then whether tasks can get it
 * now, with the last install's error while they cannot (a fix by hand after a failed install makes it old news). The button installs, or installs again over settings that do not work.
 */
export function javaNavigationSetup(install: JavaNavigationInstall): { line: string; tone: JavaNavigationSetupTone; button: string } {
  const button = install.readiness === null ? "Install" : "Install again";
  if (install.step !== null) return { line: `${install.step}…`, tone: "muted", button };
  const ready = install.readiness !== null && install.readiness.problem === null;
  if (install.error !== null && !ready) return { line: `The install failed: ${install.error}`, tone: "error", button };
  if (install.readiness === null) return { line: "Not set up yet.", tone: "muted", button };
  if (install.readiness.problem !== null) return { line: `Cannot start: ${install.readiness.problem}.`, tone: "error", button };
  return { line: "Ready: tasks in Java repos can get it on the New session form.", tone: "ok", button };
}

/**
 * The mark of a running task's Java navigation in its header (ADR-124): a short label with a tone, and a tooltip that
 * says what it means for the agent, since its `lsp` tool answers with nothing until jdtls has imported the project.
 */
export function javaNavigationMark(status: JavaNavigationStatus): { label: string; tone?: StatusTone; title: string } {
  switch (status.kind) {
    case "starting":
      return { label: "Java starting", title: "jdtls is starting; the agent's lsp tool answers once it has imported the project." };
    case "importing":
      return {
        label: "Java importing",
        title: "jdtls is importing and indexing the project; the agent's lsp tool answers once it is done.",
      };
    case "stalled":
      return {
        label: "Java import stalled",
        tone: "warning",
        title: `jdtls has been importing for over ${JAVA_NAVIGATION_STALL_MS / 60_000} minutes. Run /lsp logs in the session to see why, or resume the task to start it again.`,
      };
    case "ready":
      return { label: "Java ready", tone: "ok", title: "jdtls has imported the project; the agent's lsp tool answers." };
    case "failed":
      return {
        label: "Java import failed",
        tone: "error",
        title: `jdtls could not import the project, so the agent's lsp tool answers with nothing: ${status.message}`,
      };
  }
}

/** Asked often while jdtls is on its way, rarely once it is ready or failed. */
export function javaNavigationPollMs(status: JavaNavigationStatus | null | undefined): number {
  return status?.kind === "starting" || status?.kind === "importing" ? 3000 : 30_000;
}
