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
 * Building blocks of dashboard models (ADR-33). Models are made of simple solids so that no glTF files are shipped while
 * the look is still settling; once it settles, the same shape can come as a model through Pawn's `Model` without changing
 * the rest of the scene. Every function returns a new object with its own material, because state (colour, brightness)
 * changes per object.
 */

/**
 * The object the scene draws for an entity, with an optional animation in scene time (seconds). The scene sets the pose
 * from time 0 right after building the model and animates further only with motion on, so the model gets no motion flag.
 */
export interface HomeVisual {
  object: Object3D;
  animate?: (elapsed: number) => void;
}

/** Matte body material, optionally glowing slightly. */
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

/** Glowing material without shadows: LEDs, screens, rings. A translucent one adds light to the background. */
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

/** A flat ring lying on the floor (a torus turned horizontal). */
export function flatRing<M extends Material>(radius: number, tube: number, segments: number, material: M, y = 0): Mesh<TorusGeometry, M> {
  const mesh = new Mesh(new TorusGeometry(radius, tube, 6, segments), material);
  mesh.rotation.x = Math.PI / 2;
  mesh.position.y = y;
  return mesh;
}

/**
 * Turns off pointing at an object and its children. The Pawn pointer takes the first hit in the scene, also on an object
 * without `Hoverable`, so a decoration (wire, arc, light pillar) would hide the repos and sessions behind it.
 */
export function unpickable<T extends Object3D>(object: T): T {
  object.traverse((o) => {
    o.raycast = () => {};
  });
  return object;
}

/**
 * Edges of a solid as thin lines: a HUD drawing without shading. Lines cannot be pointed at, because three.js hits a line
 * from up to 1 unit away and a model's outline would take over its neighbour's clicks.
 */
export function outline(mesh: Mesh, color: string, opacity: number): LineSegments {
  const lines = unpickable(
    new LineSegments(new EdgesGeometry(mesh.geometry), new LineBasicMaterial({ color, transparent: true, opacity })),
  );
  lines.position.copy(mesh.position);
  lines.rotation.copy(mesh.rotation);
  return lines;
}
