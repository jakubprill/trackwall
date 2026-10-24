import {
  AdditiveBlending,
  BoxGeometry,
  CylinderGeometry,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NormalBlending,
  type Object3D,
  TorusGeometry,
} from "three";

/**
 * Klocki modeli pulpitu (ADR-33). Modele są złożone z prostych brył, żeby nie wozić plików glTF, dopóki wygląd się
 * ustala; gdy się ustali, ten sam kształt może przyjść jako model przez `Model` z Pawn bez zmiany reszty sceny.
 * Każda funkcja zwraca nowy obiekt z własnym materiałem, bo stan (kolor, jasność) zmienia się per obiekt.
 */

/**
 * Obiekt, który scena rysuje dla encji, z opcjonalną animacją w czasie sceny (sekundy). Scena ustawia pozę z chwili 0
 * zaraz po zbudowaniu modelu, a dalej animuje tylko przy włączonym ruchu, więc model nie dostaje flagi ruchu.
 */
export interface HomeVisual {
  object: Object3D;
  animate?: (elapsed: number) => void;
}

/** Matowy materiał korpusu, opcjonalnie lekko świecący. */
export function solid(color: string, glow = 0, opacity = 1): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: glow,
    roughness: 0.6,
    metalness: 0.25,
    transparent: opacity < 1,
    opacity,
  });
}

/** Świecący materiał bez cieni: diody, ekrany, pierścienie. Półprzezroczysty dodaje światło do tła. */
export function light(color: string, opacity = 1): MeshBasicMaterial {
  const translucent = opacity < 1;
  return new MeshBasicMaterial({
    color,
    transparent: translucent,
    opacity,
    depthWrite: !translucent,
    blending: translucent ? AdditiveBlending : NormalBlending,
  });
}

export function box<M extends Material>(
  size: [number, number, number],
  material: M,
  at: [number, number, number] = [0, 0, 0],
): Mesh<BoxGeometry, M> {
  const mesh = new Mesh(new BoxGeometry(...size), material);
  mesh.position.set(...at);
  return mesh;
}

export function cylinder<M extends Material>(
  radius: [top: number, bottom: number],
  height: number,
  segments: number,
  material: M,
  at: [number, number, number] = [0, 0, 0],
): Mesh<CylinderGeometry, M> {
  const mesh = new Mesh(new CylinderGeometry(radius[0], radius[1], height, segments), material);
  mesh.position.set(...at);
  return mesh;
}

/** Płaski pierścień leżący na podłodze (torus obrócony do poziomu). */
export function flatRing<M extends Material>(radius: number, tube: number, segments: number, material: M, y = 0): Mesh<TorusGeometry, M> {
  const mesh = new Mesh(new TorusGeometry(radius, tube, 6, segments), material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.y = y;
  return mesh;
}

/**
 * Wyłącza wskazywanie obiektu i jego dzieci. Wskaźnik Pawn bierze pierwsze trafienie w scenie, także w obiekt bez
 * `Hoverable`, więc ozdoba (przewód, łuk, słup światła) zasłaniałaby repo i sesje za sobą.
 */
export function unpickable<T extends Object3D>(object: T): T {
  object.traverse((o) => {
    o.raycast = () => {};
  });
  return object;
}

/**
 * Krawędzie bryły jako cienkie linie: daje rysunek HUD bez cieniowania. Linii nie da się wskazać, bo three.js trafia
 * w linię z odległości do 1 jednostki i obrys modelu przejmowałby kliknięcia sąsiada.
 */
export function outline(mesh: Mesh, color: string, opacity: number): LineSegments {
  const lines = unpickable(
    new LineSegments(new EdgesGeometry(mesh.geometry), new LineBasicMaterial({ color, transparent: true, opacity })),
  );
  lines.position.copy(mesh.position);
  lines.rotation.copy(mesh.rotation);
  return lines;
}
