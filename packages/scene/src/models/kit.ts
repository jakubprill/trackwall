import {
  AdditiveBlending,
  BoxGeometry,
  BufferGeometry,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  LineBasicMaterial,
  LineSegments,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  NormalBlending,
  type Object3D,
  RingGeometry,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
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

export function sphere<M extends Material>(radius: number, material: M, at: [number, number, number] = [0, 0, 0]): Mesh<SphereGeometry, M> {
  const mesh = new Mesh(new SphereGeometry(radius, 20, 14), material);
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
 * Translucent body of a hologram (ADR-104): the background shows through, the edges drawn with `outline` carry the shape.
 * It does not write depth, so the glowing parts inside stay visible.
 */
export function glass(color: string, glow: string, opacity = 0.5): MeshStandardMaterial {
  const material = solid(color, 0, opacity);
  material.emissive.set(glow);
  material.emissiveIntensity = 0.08;
  material.depthWrite = false;
  return material;
}

/** A flat ring or arc lying on the floor, from `start` through `span` radians, counted from +x towards +z like the layout. */
export function flatArc<M extends Material>(inner: number, outer: number, start: number, span: number, material: M): Mesh<RingGeometry, M> {
  // RingGeometry lies in the XY plane with the angle from +X to +Y; turned horizontal, +Y becomes −Z, so the scene angle is
  // the geometry angle with a minus sign.
  const mesh = new Mesh(
    new RingGeometry(inner, outer, Math.max(8, Math.ceil(span * 12)), 1, -start - span, span).rotateX(-Math.PI / 2),
    material,
  );
  mesh.material.side = DoubleSide;
  return mesh;
}

/** Short radial ticks around a circle on the floor, like the scale of a HUD dial, as one geometry. */
export function tickRing<M extends Material>(
  radius: number,
  count: number,
  length: number,
  width: number,
  material: M,
): Mesh<BufferGeometry, M> {
  const positions: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    const [cos, sin] = [Math.cos(angle), Math.sin(angle)];
    // Across the tick: perpendicular to the radius, half the width each way.
    const [dx, dz] = [-sin * (width / 2), cos * (width / 2)];
    const [inner, outer] = [radius - length / 2, radius + length / 2];
    const base = i * 4;
    positions.push(cos * inner - dx, 0, sin * inner - dz, cos * inner + dx, 0, sin * inner + dz);
    positions.push(cos * outer + dx, 0, sin * outer + dz, cos * outer - dx, 0, sin * outer - dz);
    indices.push(base, base + 2, base + 1, base, base + 3, base + 2);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  const mesh = new Mesh(geometry, material);
  mesh.material.side = DoubleSide;
  return mesh;
}

/** Side of the glow texture in pixels: it is blurred anyway, so a small one is enough. */
const GLOW_SIZE = 64;
let glowTexture: DataTexture | null = null;

/** A white spot fading to the edge, computed once; generated in code, so the scene needs no image files and no canvas. */
function glowMap(): DataTexture {
  if (glowTexture) return glowTexture;
  const data = new Uint8Array(GLOW_SIZE * GLOW_SIZE * 4);
  for (let y = 0; y < GLOW_SIZE; y++) {
    for (let x = 0; x < GLOW_SIZE; x++) {
      const distance = Math.hypot(x + 0.5 - GLOW_SIZE / 2, y + 0.5 - GLOW_SIZE / 2) / (GLOW_SIZE / 2);
      const fade = Math.max(0, 1 - distance);
      const i = (y * GLOW_SIZE + x) * 4;
      data.set([255, 255, 255, Math.round(255 * fade * fade)], i);
    }
  }
  glowTexture = new DataTexture(data, GLOW_SIZE, GLOW_SIZE);
  glowTexture.needsUpdate = true;
  return glowTexture;
}

/**
 * A soft glow around a light (ADR-104): a sprite that adds its colour to whatever is behind it. It replaces a bloom pass,
 * which costs several full-screen passes per frame and drops frames on a laptop's integrated graphics.
 */
export function glow(color: string, size: number, y: number, opacity = 1): Sprite {
  const sprite = new Sprite(
    new SpriteMaterial({ map: glowMap(), color, transparent: true, opacity, blending: AdditiveBlending, depthWrite: false }),
  );
  sprite.scale.set(size, size, 1);
  sprite.position.y = y;
  return unpickable(sprite);
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
