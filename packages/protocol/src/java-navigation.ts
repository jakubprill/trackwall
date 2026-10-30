import { z } from "zod";
import { JavaNavigationState } from "./agents.ts";
import { apiEndpoints } from "./api.ts";

/**
 * Contract of the `java-navigation` module (ADR-123): Trackwall installs the Java language server for tasks' Java
 * navigation (ADR-99) itself, a pinned jdtls release and the Java it runs on, and saves their paths as `javaNavigation`
 * in `workspace.yaml`. Every action is `POST /api/java-navigation/<action>`.
 */

/** The install of jdtls and its Java, as the Settings section and the doctor show it. */
export const JavaNavigationInstall = z.object({
  /** The jdtls version Trackwall installs (`1.63.0`). */
  jdtls: z.string(),
  /** The Java it installs through mise (`temurin-25`). */
  java: z.string(),
  /** What the running install does now, in a few words; `null` when none runs. The UI asks again until it is `null`. */
  step: z.string().nullable(),
  /** Why the last install failed; `null` after one that worked, and while none has run since the daemon started. */
  error: z.string().nullable(),
  /** Whether tasks can get Java navigation now, as the New session form sees it (`start-options`). */
  readiness: JavaNavigationState,
});
export type JavaNavigationInstall = z.infer<typeof JavaNavigationInstall>;

const endpoint = apiEndpoints("java-navigation");

export const javaNavigationApi = {
  /** The install's state, from daemon memory. */
  state: endpoint("state", z.object({}).strict(), JavaNavigationInstall),
  /**
   * Starts installing jdtls and its Java, and returns at once with the install running; a second start while one runs
   * returns the running one. Only from the UI, never from MCP: it downloads and writes `workspace.yaml`.
   */
  startInstall: endpoint("start-install", z.object({}).strict(), JavaNavigationInstall),
};
