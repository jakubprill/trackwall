/**
 * The dashboard framing (§5.5): the camera looks at the centre of the scene from above and in front, at the same angle
 * for every canvas size, and the distance follows from the canvas proportions, so that the whole repo ring is in the
 * frame. In a narrow canvas the width decides, in a wide one the height.
 */

export const HOME_CAMERA_FOV = 40;
/** The direction from the centre of the scene to the camera (y up, z towards the viewer). */
const DIRECTION = { y: 15, z: 13 };
/** The radius that has to fit in the frame: the repo ring (6.6 in scene units), the sector arcs and the tiles. */
const SCENE_EXTENT = 8.6;
export const HOME_CAMERA_MAX_DISTANCE = 44;

export function homeCameraDistance(width: number, height: number): number {
  const halfHeight = Math.tan((HOME_CAMERA_FOV * Math.PI) / 360);
  const aspect = width > 0 && height > 0 ? width / height : 1;
  return Math.min(HOME_CAMERA_MAX_DISTANCE, SCENE_EXTENT / Math.min(halfHeight, halfHeight * aspect));
}

export function homeCameraPosition(distance: number): { x: number; y: number; z: number } {
  const scale = distance / Math.hypot(DIRECTION.y, DIRECTION.z);
  return { x: 0, y: DIRECTION.y * scale, z: DIRECTION.z * scale };
}
