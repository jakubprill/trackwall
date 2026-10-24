/**
 * Kadr pulpitu (§5.5): kamera patrzy na środek sceny z góry i z przodu, pod tym samym kątem przy każdym rozmiarze
 * płótna, a odległość wynika z proporcji płótna, żeby cały pierścień repo był w kadrze. W wąskim płótnie decyduje
 * szerokość, w szerokim wysokość.
 */

export const HOME_CAMERA_FOV = 40;
/** Kierunek od środka sceny do kamery (y w górę, z do widza). */
const DIRECTION = { y: 15, z: 13 };
/** Promień, który musi zmieścić się w kadrze: pierścień repo (6,6 w jednostkach sceny), łuki sektorów i kafle. */
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
