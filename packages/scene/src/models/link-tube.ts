import type { EdgeSource } from "@trackwall/protocol";
import { type Curve, Group, Mesh, TubeGeometry, type Vector3 } from "three";
import { box, type HomeVisual, light, unpickable } from "./kit.ts";

/**
 * A wire as a thin tube with packets flowing along it (ADR-33). For a connection from the graph, an HTTP connection is
 * thicker, faster and denser, a package connection thinner and slower, and a manual connection the thinnest and without
 * packets; thickness tells the kinds apart even without motion. A session wire joins a drone to its repo. The scene sets a connection wire's brightness
 * through `setEmphasis` when the selected repo is one of its ends.
 */

/** Names of the wire tubes in the three.js scene: they let you find the tubes without knowing entity keys. */
export const TUBE_NAMES = { link: "link", tether: "tether" } as const;

interface TubeSpec {
  name: (typeof TUBE_NAMES)[keyof typeof TUBE_NAMES];
  packets: number;
  speed: number;
  radius: number;
}

export const LINK_TUBES: Record<EdgeSource, TubeSpec> = {
  http: { name: TUBE_NAMES.link, packets: 3, speed: 0.35, radius: 0.02 },
  package: { name: TUBE_NAMES.link, packets: 1, speed: 0.16, radius: 0.012 },
  manual: { name: TUBE_NAMES.link, packets: 0, speed: 0, radius: 0.007 },
};

export const TETHER_TUBE: TubeSpec = { name: TUBE_NAMES.tether, packets: 1, speed: 0.3, radius: 0.01 };

/** Wire brightness: `normal` with nothing selected, `lit` when one end is selected, `dim` when the selection is elsewhere. */
export type LinkEmphasis = "normal" | "lit" | "dim";
const OPACITY: Record<LinkEmphasis, number> = { normal: 0.22, lit: 0.85, dim: 0.05 };

export interface LinkVisual extends HomeVisual {
  setEmphasis: (emphasis: LinkEmphasis) => void;
}

export function linkTube(curve: Curve<Vector3>, spec: TubeSpec, color: string): LinkVisual {
  const group = new Group();
  const tube = new Mesh(new TubeGeometry(curve, 48, spec.radius, 5, false), light(color, OPACITY.normal));
  tube.name = spec.name;
  group.add(tube);
  const packets = Array.from({ length: spec.packets }, () => box([0.06, 0.06, 0.06], light(color, 0.95)));
  if (packets.length > 0) group.add(...packets);
  unpickable(group);
  return {
    object: group,
    setEmphasis: (emphasis) => {
      tube.material.opacity = OPACITY[emphasis];
      for (const packet of packets) packet.visible = emphasis !== "dim";
    },
    animate: (t) => {
      for (const [i, packet] of packets.entries()) {
        packet.position.copy(curve.getPoint((t * spec.speed + i / packets.length) % 1));
      }
    },
  };
}
