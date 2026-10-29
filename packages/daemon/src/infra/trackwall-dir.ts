import { join } from "node:path";
import { TRACKWALL_DIR } from "@trackwall/protocol";

/** A folder of Trackwall's folder in the projects folder (ADR-125), such as `LOCAL_CONFIG_STORE_DIR`. */
export function trackwallDir(projectsDir: string, name: string): string {
  return join(projectsDir, TRACKWALL_DIR, name);
}
