import { Group } from "three";
import type { HomeSession } from "../home-model.ts";
import { type ScenePalette, sessionStateColor } from "../palette.ts";
import { cylinder, flatRing, type HomeVisual, light, outline, solid } from "./kit.ts";

/**
 * Sesja Copilot jako dron (ADR-33): sześciokątny korpus z pierścieniem, który kręci się, gdy sesja pracuje.
 * Sesja, która czeka na Ciebie albo skończyła się błędem, ma słup światła z unoszącym się pierścieniem, widoczny
 * z każdego miejsca sceny; to jedyny tak głośny element pulpitu.
 */

/** Wysokość słupa światła nad dronem. */
const BEACON_HEIGHT = 2.6;

export function sessionPod(session: HomeSession, palette: ScenePalette, motion: boolean): HomeVisual {
  // Scena co klatkę przepisuje pozycję encji do obiektu, więc kołysze się wewnętrzna grupa, nie obiekt encji.
  const root = new Group();
  const group = new Group();
  root.add(group);
  const phase = [...session.id].reduce((sum, c) => sum + c.charCodeAt(0), 0);
  const color = sessionStateColor(session.state, palette);
  const body = cylinder([0.17, 0.2], 0.14, 6, solid(palette.body), [0, 0, 0]);
  group.add(body, outline(body, color, 0.9));
  group.add(cylinder([0.09, 0.09], 0.02, 12, light(color), [0, 0.08, 0]));
  const ring = flatRing(0.29, 0.014, 6, light(color, 0.9));
  group.add(ring);
  const beacon = session.state === "attention" || session.state === "error" ? addBeacon(group, color) : null;
  if (!motion) return { object: root };
  return {
    object: root,
    animate: (t) => {
      group.position.y = 0.05 * Math.sin(t * 1.6 + phase);
      if (session.state === "working") ring.rotation.z = t * 2.2;
      if (beacon) beacon(t);
    },
  };
}

/** Słup światła i pierścień, który wznosi się po nim i gaśnie; zwraca animację. */
function addBeacon(group: Group, color: string): (elapsed: number) => void {
  const shaft = cylinder([0.045, 0.1], BEACON_HEIGHT, 12, light(color, 0.25), [0, BEACON_HEIGHT / 2 + 0.05, 0]);
  const rising = flatRing(0.14, 0.012, 24, light(color, 0.9));
  group.add(shaft, rising);
  return (t) => {
    const progress = (t * 0.6) % 1;
    rising.position.y = 0.1 + progress * (BEACON_HEIGHT - 0.2);
    rising.material.opacity = 0.9 * (1 - progress);
    shaft.material.opacity = 0.18 + 0.14 * Math.sin(t * 4);
  };
}
