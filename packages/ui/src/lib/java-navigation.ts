import { JAVA_TAG, type JavaNavigationInstall, type JavaNavigationState, type RepoTag } from "@trackwall/protocol";

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
 * What the Java navigation section of Settings says (ADR-123): a running install's step, then a failed install's error,
 * then whether tasks can get it now. The button installs, or installs again over settings that do not work.
 */
export function javaNavigationSetup(install: JavaNavigationInstall): { line: string; tone: JavaNavigationSetupTone; button: string } {
  const button = install.readiness === null ? "Install" : "Install again";
  if (install.running) return { line: `${install.step ?? "Installing"}…`, tone: "muted", button };
  if (install.error !== null) return { line: `The install failed: ${install.error}`, tone: "error", button };
  if (install.readiness === null) return { line: "Not set up yet.", tone: "muted", button };
  if (install.readiness.problem !== null) return { line: `Cannot start: ${install.readiness.problem}.`, tone: "error", button };
  return { line: "Ready: tasks in Java repos can get it on the New session form.", tone: "ok", button };
}
