import type { ContainerId } from "@trackwall/protocol";
import { DomainError } from "./errors.ts";

/**
 * Whether the daemon can open a link, a folder or VS Code on the user's desktop (ADR-120). In a container or on a Linux
 * system without a graphical session nothing would open and nobody would see why, so the page opens web links itself and
 * the daemon refuses the rest with `no_desktop` (§4.5).
 */

/** The files Docker and Podman put into every container. */
const CONTAINER_MARKERS = ["/.dockerenv", "/run/.containerenv"] as const;

/**
 * The id of the container the daemon runs in, for VS Code links into it (ADR-121). Docker and Podman mount the
 * container's `hostname`, `hosts` and `resolv.conf` from a folder named after its full id, which `/proc/self/mountinfo`
 * shows; the hostname is only a default and the cgroup path is hidden under cgroup v2.
 */
export function containerId(mountinfo: string): ContainerId | null {
  return /containers\/([0-9a-f]{64})\//.exec(mountinfo)?.[1] ?? null;
}

export interface DesktopProbe {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  exists: (path: string) => boolean;
}

export function hasDesktop({ platform, env, exists }: DesktopProbe): boolean {
  if (platform === "win32" || platform === "darwin") return true;
  // A dev container can see a display socket of the host (WSLg), yet a link opened inside it reaches no browser of the user.
  if (CONTAINER_MARKERS.some(exists)) return false;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

/** The facade's `openUrl` and `openFolder`, repeated here because infrastructure does not import the facade. */
export interface Openers {
  openUrl: (url: string) => void;
  openFolder: (dir: string) => void;
}

/** The system's openers where there is a desktop; otherwise openers that refuse with `no_desktop` instead of failing unseen. */
export function desktopOpeners(desktop: boolean, system: Openers): Openers {
  if (desktop) return system;
  return {
    openUrl: () => {
      throw noDesktop("a link or VS Code");
    },
    openFolder: () => {
      throw noDesktop("a folder");
    },
  };
}

function noDesktop(what: string): DomainError {
  return new DomainError(
    "no_desktop",
    `Trackwall runs without a desktop here (for example in a container), so it cannot open ${what} on your computer`,
  );
}
