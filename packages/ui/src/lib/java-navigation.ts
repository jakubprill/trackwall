import { JAVA_TAG, type JavaNavigationState, type RepoTag } from "@trackwall/protocol";

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
      reason: "Not set up yet: add javaNavigation to workspace.yaml, as the Java navigation page of the documentation shows.",
    };
  if (state.problem !== null) return { kind: "unavailable", reason: `Cannot start: ${state.problem}.` };
  return { kind: "ready" };
}
