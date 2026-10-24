import { CameraRig, Engine, Labels, Pointer } from "@pawnjs/core";
import { type HomeKey, type HomeModel, HomeScene, type LabelTarget } from "@trackwall/scene";
import { useEffect, useRef } from "react";
import { readScenePalette } from "@/lib/scene-palette";

/**
 * Płótno pulpitu: silnik Pawn z kamerą, wskaźnikiem i etykietami, a w nim `HomeScene` (ADR-33). Ładowane leniwie
 * (`React.lazy`), bo three.js i Pawn to większość wagi widoku, a inne widoki ich nie potrzebują. Gdy WebGL nie
 * działa (stary sterownik, zablokowana karta) albo kontekst przepadnie, wywołuje `onUnavailable`, a widok zostaje
 * przy panelach HTML.
 */

export interface HomeCanvasProps {
  model: HomeModel;
  /** Wybrany obiekt z panelu (np. z kolejki „Needs you”): scena podświetla go i kieruje na niego kamerę. */
  focus: HomeKey | null;
  onSelect: (key: HomeKey | null) => void;
  onOpen: (key: HomeKey) => void;
  onHover: (key: HomeKey | null) => void;
  labelText: (target: LabelTarget) => string;
  onUnavailable: (reason: string) => void;
}

/** Kamera patrzy z góry i z przodu, pod tym samym kątem przy każdym rozmiarze okna. */
const CAMERA_DIRECTION = { y: 15, z: 13 };
const CAMERA_FOV = 40;
/** Promień, który musi zmieścić się w kadrze: pierścień repo (6,6 w jednostkach sceny), łuki sektorów i kafle. */
const SCENE_EXTENT = 8.6;
const MAX_DISTANCE = 44;

/**
 * Odległość kamery dobrana do proporcji płótna: w wąskim płótnie decyduje szerokość, w szerokim wysokość, więc cały
 * pierścień jest w kadrze bez względu na to, jak szerokie są panele po bokach.
 */
export function homeCamera(width: number, height: number) {
  const halfHeight = Math.tan((CAMERA_FOV * Math.PI) / 360);
  const aspect = width > 0 && height > 0 ? width / height : 1;
  const distance = Math.min(MAX_DISTANCE, SCENE_EXTENT / Math.min(halfHeight, halfHeight * aspect));
  const scale = distance / Math.hypot(CAMERA_DIRECTION.y, CAMERA_DIRECTION.z);
  return { position: { x: 0, y: CAMERA_DIRECTION.y * scale, z: CAMERA_DIRECTION.z * scale }, fov: CAMERA_FOV };
}

export function HomeCanvas(props: HomeCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<{ scene: HomeScene; rig: CameraRig } | null>(null);
  // Najświeższe wywołania zwrotne bez odtwarzania silnika przy każdym renderze rodzica.
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const canvas = document.createElement("canvas");
    canvas.className = "block size-full";
    host.prepend(canvas);
    let engine: Engine;
    try {
      engine = new Engine({
        canvas,
        fit: host,
        enableTransparency: true,
        lights: "studio",
        camera: homeCamera(host.clientWidth, host.clientHeight),
      });
    } catch (err) {
      canvas.remove();
      latest.current.onUnavailable(err instanceof Error ? err.message : String(err));
      return;
    }
    const rig = new CameraRig({ minDistance: 8, maxDistance: MAX_DISTANCE, maxPolarAngle: Math.PI * 0.45, enablePan: false });
    engine
      .use(new Pointer())
      .use(new Labels({ container: host }))
      .use(rig);
    const motion = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const scene = new HomeScene(engine, {
      palette: readScenePalette(host),
      motion,
      onSelect: (key) => latest.current.onSelect(key),
      onOpen: (key) => latest.current.onOpen(key),
      onHover: (key) => latest.current.onHover(key),
      createLabel: (target) => sceneLabel(latest.current.labelText(target), target),
    });
    sceneRef.current = { scene, rig };
    scene.apply(latest.current.model);
    const lost = (event: Event) => {
      event.preventDefault();
      latest.current.onUnavailable("The graphics context was lost");
    };
    canvas.addEventListener("webglcontextlost", lost);
    // Schowane okno nie rysuje: Pawn sam nie wstrzymuje pętli (zgłoszenie do Pawn), a WebView w trayu dalej liczyłby klatki.
    const visibility = () => (document.hidden ? engine.stop() : engine.start());
    document.addEventListener("visibilitychange", visibility);
    if (!document.hidden) engine.start();
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      canvas.removeEventListener("webglcontextlost", lost);
      sceneRef.current = null;
      scene.dispose();
      engine.dispose();
      canvas.remove();
    };
  }, []);

  useEffect(() => {
    sceneRef.current?.scene.apply(props.model);
  }, [props.model]);

  useEffect(() => {
    const current = sceneRef.current;
    if (!current) return;
    current.scene.focus(props.focus);
    const entity = props.focus && current.scene.entity(props.focus);
    if (entity) current.rig.focus(entity);
    else current.rig.reset();
  }, [props.focus]);

  return <div ref={hostRef} className="relative size-full overflow-hidden" />;
}

/** Etykieta przy obiekcie: zwięzła, w stylu podpisów HUD; czekająca sesja i błąd mają swój kolor. */
function sceneLabel(text: string, target: LabelTarget): HTMLElement {
  const label = document.createElement("div");
  label.textContent = text;
  label.className = `bg-background/80 pointer-events-none rounded-sm border px-1.5 py-0.5 font-mono text-2xs whitespace-nowrap ${labelTone(target)}`;
  return label;
}

function labelTone(target: LabelTarget): string {
  const error = target.kind === "session" ? target.session.state === "error" : target.repo.state === "unavailable";
  if (error) return "text-destructive";
  return target.kind === "session" ? "text-warning" : "text-foreground";
}
