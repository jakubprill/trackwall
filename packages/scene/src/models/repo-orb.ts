import { Group } from "three";
import { repoNeedsYou } from "../home-model.ts";
import { repoStateColor, type ScenePalette } from "../palette.ts";
import { cylinder, flatArc, flatRing, glow, type HomeVisual, light, sphere, unpickable } from "./kit.ts";
import { MAX_REPO_LEVEL, type RepoLook } from "./repo-model.ts";
import { addServiceRing } from "./service-ring.ts";

/**
 * Repo model in the `orbs` style (ADR-104): a glowing sphere in the state colour above a mark on the floor, bigger with more
 * changes or commits to pull, with a ring around it while a mise task runs and the service ring on the floor while a
 * service runs (ADR-191). Fewer and simpler parts than `holo`, for a weak graphics card; the kind of repo is not shown.
 */

const ORB_Y = 0.7;
/** Radius of the service ring on the floor, around the orb's mark. */
const SERVICE_RADIUS = 0.26;

export function repoOrb(look: RepoLook, palette: ScenePalette): HomeVisual {
  const group = new Group();
  const color = repoStateColor(look.state, palette);
  const quiet = !repoNeedsYou(look.state);
  const radius = 0.28 + (0.17 * look.level) / MAX_REPO_LEVEL;
  const orb = sphere(radius, light(color, 0.95), [0, ORB_Y, 0]);
  group.add(orb, glow(color, radius * (quiet ? 5 : 8), ORB_Y, quiet ? 0.45 : 0.8));
  group.add(cylinder([0.008, 0.008], ORB_Y - radius, 4, light(color, 0.5), [0, (ORB_Y - radius) / 2, 0]));
  group.add(unpickable(flatArc(0.12, 0.16, 0, Math.PI * 2, light(color, 0.8))));
  const animations: Array<(t: number) => void> = [];
  if (look.taskRunning) {
    const ring = flatRing(radius + 0.12, 0.01, 40, light(palette.primary, 0.9), ORB_Y);
    group.add(ring);
    animations.push((t) => ring.rotation.set(Math.PI / 2 + t * 1.2, t * 0.7, 0));
  }
  if (look.service !== null) {
    const service = addServiceRing(group, look.service, palette, SERVICE_RADIUS);
    if (service) animations.push(service);
  }
  if (look.state === "unavailable") animations.push((t) => (orb.material.opacity = Math.sin(t * 13) > 0.6 ? 0.95 : 0.4));
  return {
    object: group,
    animate: (t) => {
      for (const animation of animations) animation(t);
    },
  };
}
