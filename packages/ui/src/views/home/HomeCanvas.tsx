import { CameraRig, Engine, Labels, Pointer } from "@pawnjs/core";
import { HomeScene, type LabelTarget } from "@trackwall/scene";
import type { HomeKey, HomeModel } from "@trackwall/scene/model";
import { useEffect, useRef } from "react";
import { errorMessage } from "@/lib/api";
import { HOME_CAMERA_FOV, HOME_CAMERA_MAX_DISTANCE, homeCameraDistance, homeCameraPosition } from "@/lib/home-camera";
import { HOME_SESSION_STATUS, type HomeStatus, homeRepoStatus } from "@/lib/home-model";
import { readScenePalette } from "@/lib/scene-palette";
import { statusTextClass } from "@/lib/status-tone";
import { cn } from "@/lib/utils";

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
  onUnavailable: (reason: string) => void;
}

const ORIGIN = { x: 0, y: 0, z: 0 };

interface Mounted {
  scene: HomeScene;
  rig: CameraRig;
  /** Kadr całej sceny dla bieżącego rozmiaru płótna. */
  overview: () => void;
}

export function HomeCanvas(props: HomeCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef<Mounted | null>(null);
  // Najświeższe wywołania zwrotne bez odtwarzania silnika przy każdym renderze rodzica.
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const created = createEngine(host, (reason) => latest.current.onUnavailable(reason));
    if (!created) return;
    const { engine, canvas } = created;
    const rig = new CameraRig({ minDistance: 8, maxDistance: HOME_CAMERA_MAX_DISTANCE, maxPolarAngle: Math.PI * 0.45, enablePan: false });
    engine
      .use(new Pointer())
      .use(new Labels({ container: host }))
      .use(rig);
    let scene: HomeScene;
    try {
      scene = new HomeScene(engine, {
        palette: readScenePalette(host),
        motion: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        onSelect: (key) => latest.current.onSelect(key),
        onOpen: (key) => latest.current.onOpen(key),
        onHover: (key) => latest.current.onHover(key),
        createLabel: sceneLabel,
      });
    } catch (err) {
      // Paleta bez płótna 2D albo kolor tokenu, którego scena nie przyjmie: bez sceny silnik też znika.
      engine.dispose();
      canvas.remove();
      latest.current.onUnavailable(errorMessage(err));
      return;
    }
    // Ten sam kąt co na starcie (`reset` cofa obrót użytkownika) i odległość dla bieżących proporcji płótna.
    const overview = (immediate = false) => {
      rig.reset({ immediate });
      rig.focus(ORIGIN, { distance: homeCameraDistance(host.clientWidth, host.clientHeight), immediate });
    };
    mountedRef.current = { scene, rig, overview };
    scene.apply(latest.current.model);
    // Zmiana rozmiaru okna albo paneli: bez wybranego obiektu kadr wraca do całej sceny dla nowych proporcji.
    engine.fitToElement(host, () => {
      if (!latest.current.focus) overview(true);
    });
    const lost = (event: Event) => {
      event.preventDefault();
      latest.current.onUnavailable("the graphics context was lost");
    };
    canvas.addEventListener("webglcontextlost", lost);
    // Schowane okno nie rysuje: Pawn sam nie wstrzymuje pętli (zgłoszenie do Pawn), a WebView w trayu dalej liczyłby klatki.
    const visibility = () => (document.hidden ? engine.stop() : engine.start());
    document.addEventListener("visibilitychange", visibility);
    if (!document.hidden) engine.start();
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      canvas.removeEventListener("webglcontextlost", lost);
      mountedRef.current = null;
      scene.dispose();
      engine.dispose();
      canvas.remove();
    };
  }, []);

  useEffect(() => {
    mountedRef.current?.scene.apply(props.model);
  }, [props.model]);

  useEffect(() => {
    const mounted = mountedRef.current;
    if (!mounted) return;
    mounted.scene.focus(props.focus);
    const entity = props.focus && mounted.scene.entity(props.focus);
    if (entity) mounted.rig.focus(entity);
    else mounted.overview();
  }, [props.focus]);

  return <div ref={hostRef} className="relative size-full overflow-hidden" />;
}

/**
 * Silnik na nowym płótnie albo `null` z powodem w `onUnavailable`. WebGL 2 jest sprawdzany na osobnym płótnie przed
 * silnikiem, bo nieudany konstruktor `Engine` zostawia świat koota, którego nie da się zwolnić (limit 16 na stronę).
 */
function createEngine(host: HTMLElement, onUnavailable: (reason: string) => void): { engine: Engine; canvas: HTMLCanvasElement } | null {
  const probe = document.createElement("canvas").getContext("webgl2");
  if (!probe) {
    onUnavailable("WebGL 2 is not available");
    return null;
  }
  // Kontekst próbny zwalniany od razu: przeglądarka trzyma najwyżej kilkanaście naraz i gubi najstarsze.
  probe.getExtension("WEBGL_lose_context")?.loseContext();
  const canvas = document.createElement("canvas");
  canvas.className = "block size-full";
  host.prepend(canvas);
  const distance = homeCameraDistance(host.clientWidth, host.clientHeight);
  try {
    const engine = new Engine({
      canvas,
      enableTransparency: true,
      lights: "studio",
      camera: { position: homeCameraPosition(distance), fov: HOME_CAMERA_FOV },
    });
    return { engine, canvas };
  } catch (err) {
    canvas.remove();
    onUnavailable(errorMessage(err));
    return null;
  }
}

/** Etykieta przy obiekcie: sama nazwa repo albo stan sesji, w stylu podpisów HUD i w kolorze stanu. */
function sceneLabel(target: LabelTarget): HTMLElement {
  const status: HomeStatus = target.kind === "repo" ? homeRepoStatus(target.repo) : HOME_SESSION_STATUS[target.session.state];
  const label = document.createElement("div");
  label.textContent = target.kind === "repo" ? target.repo.id : status.label;
  label.className = cn(
    "bg-background/80 text-foreground pointer-events-none rounded-sm border px-1.5 py-0.5 font-mono text-2xs whitespace-nowrap",
    statusTextClass(status.tone),
  );
  return label;
}
