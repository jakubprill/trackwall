import type { EdgeKind } from "@trackwall/protocol";
import { type Curve, Group, Mesh, TubeGeometry, type Vector3 } from "three";
import { box, type HomeVisual, light, unpickable } from "./kit.ts";

/**
 * Przewód jako cienka rura, po której płyną pakiety (ADR-33). Połączenie z grafu: HTTP grubsze, szybciej i gęściej,
 * paczka cieńsza i wolniej, ręczne połączenie najcieńsze i bez pakietów; grubość odróżnia rodzaje także bez ruchu.
 * Przewód sesji łączy drona z jego repo. Jasność przewodu połączenia ustawia scena przez `setEmphasis`, gdy wybrane
 * repo jest jednym z końców.
 */

/** Nazwy rur przewodów w scenie three.js: po nich da się je znaleźć bez znajomości kluczy encji. */
export const TUBE_NAMES = { link: "link", tether: "tether" } as const;

interface TubeSpec {
  name: (typeof TUBE_NAMES)[keyof typeof TUBE_NAMES];
  packets: number;
  speed: number;
  radius: number;
}

export const LINK_TUBES: Record<EdgeKind, TubeSpec> = {
  http: { name: TUBE_NAMES.link, packets: 3, speed: 0.35, radius: 0.02 },
  package: { name: TUBE_NAMES.link, packets: 1, speed: 0.16, radius: 0.012 },
  manual: { name: TUBE_NAMES.link, packets: 0, speed: 0, radius: 0.007 },
};

export const TETHER_TUBE: TubeSpec = { name: TUBE_NAMES.tether, packets: 1, speed: 0.3, radius: 0.01 };

/** Jasność przewodu: `normal` bez wyboru, `lit` przy wybranym końcu, `dim` przy wyborze gdzie indziej. */
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
