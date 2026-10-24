import { Mesh, RingGeometry } from "three";
import type { ScenePalette } from "../palette.ts";
import { type HomeVisual, light } from "./kit.ts";

/**
 * Łuk warstwy na zewnątrz pierścienia repo. Płaski pierścień z kątem to `RingGeometry`, bo `Shape` z Pawn nie ma
 * jeszcze łuku (zgłoszenie do Pawn); taka encja nie trafia do migawek Pawn, ale scena odtwarza ją z modelu.
 */
export function sectorArc(radius: number, start: number, span: number, palette: ScenePalette): HomeVisual {
  // RingGeometry leży w płaszczyźnie XY z kątem od +X do +Y; po obrocie do poziomu +Y przechodzi w −Z, więc kąt
  // sceny (od +X do +Z) to kąt geometrii ze znakiem minus.
  const geometry = new RingGeometry(radius, radius + 0.06, 64, 1, -start - span, span).rotateX(-Math.PI / 2);
  return { object: new Mesh(geometry, light(palette.accent, 0.5)) };
}
