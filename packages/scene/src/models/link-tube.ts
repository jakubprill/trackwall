import type { EdgeKind } from "@trackwall/protocol";
import { type Curve, Group, Mesh, TubeGeometry, type Vector3 } from "three";
import { box, type HomeVisual, light } from "./kit.ts";

/**
 * Połączenie między repo jako cienki przewód, po którym płyną pakiety (ADR-33): HTTP szybciej i gęściej, paczka
 * wolniej, ręczne połączenie bez pakietów i cieńsze. Jasność przewodu ustawia scena przez `setEmphasis`, gdy
 * wybrane albo wskazane repo jest jednym z końców.
 */

const PACKETS: Record<EdgeKind, { count: number; speed: number; radius: number }> = {
  http: { count: 3, speed: 0.35, radius: 0.014 },
  package: { count: 1, speed: 0.16, radius: 0.014 },
  manual: { count: 0, speed: 0, radius: 0.008 },
};

/** Jasność przewodu: `normal` bez wyboru, `lit` przy wybranym końcu, `dim` przy wyborze gdzie indziej. */
export type LinkEmphasis = "normal" | "lit" | "dim";
const OPACITY: Record<LinkEmphasis, number> = { normal: 0.22, lit: 0.85, dim: 0.05 };

export interface LinkVisual extends HomeVisual {
  setEmphasis: (emphasis: LinkEmphasis) => void;
}

export function linkTube(curve: Curve<Vector3>, kind: EdgeKind, color: string, motion: boolean): LinkVisual {
  const group = new Group();
  const spec = PACKETS[kind];
  const tube = new Mesh(new TubeGeometry(curve, 48, spec.radius, 5, false), light(color, OPACITY.normal));
  group.add(tube);
  const packets = motion ? Array.from({ length: spec.count }, () => box([0.06, 0.06, 0.06], light(color, 0.95))) : [];
  if (packets.length > 0) group.add(...packets);
  let packetsShown = true;
  return {
    object: group,
    setEmphasis: (emphasis) => {
      tube.material.opacity = OPACITY[emphasis];
      packetsShown = emphasis !== "dim";
    },
    animate: (t) => {
      packets.forEach((packet, i) => {
        packet.visible = packetsShown;
        packet.position.copy(curve.getPoint((t * spec.speed + i / packets.length) % 1));
      });
    },
  };
}
