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
 * container's `/etc/hostname` from a folder named after its full id, which `/proc/self/mountinfo` shows as the root of
 * that mount; the hostname itself is only a default, and the cgroup path is hidden under cgroup v2. Only that one mount
 * counts: a host's own table can list folders of other containers.
 */
export function containerId(mountinfo: string): ContainerId | null {
  for (const line of mountinfo.split("\n")) {
    const [, , , root, mountPoint] = line.split(" ");
    if (mountPoint !== "/etc/hostname" || root === undefined) continue;
    const id = /containers\/([0-9a-f]{64})\//.exec(root)?.[1];
    if (id) return id;
  }
  return null;
}

/** The container this daemon runs in, read only inside one (ADR-121); `null` elsewhere or when `/proc` cannot be read. */
export function ownContainer({ exists, read }: { exists: (path: string) => boolean; read: (path: string) => string }): ContainerId | null {
  if (!CONTAINER_MARKERS.some(exists)) return null;
  try {
    return containerId(read("/proc/self/mountinfo"));
  } catch {
    return null;
  }
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
