import { CameraRig, Engine, Labels, type LoopDriver, Pointer } from "@pawnjs/core";
import { HomeScene, type LabelTarget } from "@trackwall/scene";
import { type HomeKey, type HomeModel, repoNeedsYou } from "@trackwall/scene/model";
import { useEffect, useRef } from "react";
import { errorMessage } from "@/lib/api";
import { HOME_CAMERA_FOV, HOME_CAMERA_MAX_DISTANCE, homeCameraDistance, homeCameraPosition } from "@/lib/home-camera";
import { HOME_SESSION_STATUS, homeRepoStatus } from "@/lib/home-model";
import { readHomeSceneSettings } from "@/lib/home-scene-settings";
import { PacedFrames } from "@/lib/paced-frames";
import { readScenePalette } from "@/lib/scene-palette";
import { statusTextClass } from "@/lib/status-tone";
import { cn } from "@/lib/utils";

/**
 * The dashboard canvas: the Pawn engine with a camera, pointer and labels, with `HomeScene` in it (ADR-33). Loaded lazily
 * (`React.lazy`), because three.js and Pawn are most of the view's weight and other views do not need them. When WebGL
 * does not work (an old driver, a blocked GPU) or the context is lost, it calls `onUnavailable`, and the view stays
 * with the HTML panels.
 */

export interface HomeCanvasProps {
  model: HomeModel;
  /** The object selected from a panel (for example from the "Needs you" queue): the scene highlights it and points the camera at it. */
  focus: HomeKey | null;
  onSelect: (key: HomeKey | null) => void;
  onOpen: (key: HomeKey) => void;
  onHover: (key: HomeKey | null) => void;
  onUnavailable: (reason: string) => void;
}

const ORIGIN = { x: 0, y: 0, z: 0 };
const SCENE_FAILED = "the 3D scene could not be built";

interface Mounted {
  scene: HomeScene;
  frames: PacedFrames;
  rig: CameraRig;
  /** The framing of the whole scene for the current canvas size. */
  overview: () => void;
}

export function HomeCanvas(props: HomeCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef<Mounted | null>(null);
  // The latest callbacks without recreating the engine on every render of the parent.
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const frames = new PacedFrames();
    const created = createEngine(host, frames, (reason) => latest.current.onUnavailable(reason));
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
        // Read once: Settings is another view, so a change reaches the scene the next time Home opens.
        ...readHomeSceneSettings(() => window.localStorage),
        motion: !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        onSelect: (key) => latest.current.onSelect(key),
        onOpen: (key) => latest.current.onOpen(key),
        onHover: (key) => latest.current.onHover(key),
        createLabel: sceneLabel,
      });
      scene.apply(latest.current.model);
    } catch (err) {
      // A palette without a 2D canvas, a token colour the scene does not accept, or a layout error: without the scene the engine
      // goes too. The scene's messages are for people developing Trackwall, so the UI gets a general text.
      console.error(err);
      engine.dispose();
      canvas.remove();
      latest.current.onUnavailable(SCENE_FAILED);
      return;
    }
    // The same angle as at the start (`reset` undoes the user's rotation) and the distance for the current canvas proportions.
    const overview = () => {
      rig.reset();
      rig.focus(ORIGIN, { distance: homeCameraDistance(host.clientWidth, host.clientHeight) });
    };
    mountedRef.current = { scene, frames, rig, overview };
    // Pointing, dragging and zooming are the user working with the scene: every frame while they last (ADR-106).
    const wake = () => frames.wake();
    const interactions = ["pointermove", "pointerdown", "wheel"] as const;
    const listening = { capture: true, passive: true };
    for (const type of interactions) host.addEventListener(type, wake, listening);
    // Resizing the window or the panels: without a selected object the distance fits the new proportions, and the user's
    // rotation stays.
    engine.fitToElement(host, () => {
      frames.wake();
      if (!latest.current.focus) rig.focus(ORIGIN, { distance: homeCameraDistance(host.clientWidth, host.clientHeight), immediate: true });
    });
    const lost = (event: Event) => {
      event.preventDefault();
      latest.current.onUnavailable("the graphics context was lost");
    };
    canvas.addEventListener("webglcontextlost", lost);
    // A hidden window does not draw: Pawn does not pause its loop by itself (reported to Pawn), and a WebView in the tray
    // would keep computing frames.
    const visibility = () => (document.hidden ? engine.stop() : engine.start());
    document.addEventListener("visibilitychange", visibility);
    frames.wake();
    if (!document.hidden) engine.start();
    return () => {
      for (const type of interactions) host.removeEventListener(type, wake, listening);
      document.removeEventListener("visibilitychange", visibility);
      canvas.removeEventListener("webglcontextlost", lost);
      mountedRef.current = null;
      scene.dispose();
      engine.dispose();
      canvas.remove();
    };
  }, []);

  useEffect(() => {
    try {
      mountedRef.current?.scene.apply(props.model);
    } catch (err) {
      console.error(err);
      latest.current.onUnavailable(SCENE_FAILED);
    }
  }, [props.model]);

  useEffect(() => {
    const mounted = mountedRef.current;
    if (!mounted) return;
    // The camera flies to the object.
    mounted.frames.wake();
    mounted.scene.focus(props.focus);
    const entity = props.focus && mounted.scene.entity(props.focus);
    if (entity) mounted.rig.focus(entity);
    else mounted.overview();
  }, [props.focus]);

  return <div ref={hostRef} className="relative size-full overflow-hidden" />;
}

/**
 * The engine on a new canvas, or `null` with the reason in `onUnavailable`. WebGL 2 is checked on a separate canvas before
 * the engine, because a failed `Engine` constructor leaves a koota world behind that cannot be freed (a limit of 16 per page).
 */
function createEngine(
  host: HTMLElement,
  driver: LoopDriver,
  onUnavailable: (reason: string) => void,
): { engine: Engine; canvas: HTMLCanvasElement } | null {
  const probe = document.createElement("canvas").getContext("webgl2");
  if (!probe) {
    onUnavailable("WebGL 2 is not available");
    return null;
  }
  // The test context is released at once: a browser holds at most a dozen or so at a time and drops the oldest.
  probe.getExtension("WEBGL_lose_context")?.loseContext();
  const canvas = document.createElement("canvas");
  canvas.className = "block size-full";
  host.prepend(canvas);
  const distance = homeCameraDistance(host.clientWidth, host.clientHeight);
  try {
    const engine = new Engine({
      canvas,
      driver,
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

/**
 * The label at an object, a callout the scene places beside it (ADR-104): the repo name, and when something is going on
 * the state and the running mise task, in the state colour; a session's state. The leader line is drawn by `scene-callout`
 * in the text colour, so it takes the state colour too.
 */
function sceneLabel(target: LabelTarget): HTMLElement {
  const label = document.createElement("div");
  if (target.kind === "session") {
    const status = HOME_SESSION_STATUS[target.session.state];
    label.className = cn("scene-callout tracking-hud uppercase", statusTextClass(status.tone));
    label.textContent = status.label;
    return label;
  }
  const { repo, tone } = target;
  const status = homeRepoStatus(repo);
  // A clean or loading repo with a full label has a running task: work going on, in the primary colour like on the scene.
  const color = tone === "quiet" ? "text-muted-foreground" : !repoNeedsYou(repo.state) ? "text-primary" : statusTextClass(status.tone);
  label.className = cn("scene-callout text-2xs", color);

  label.append(line(repo.id, tone === "quiet" ? "" : "text-muted-foreground"));
  if (repoNeedsYou(repo.state)) label.append(line(status.label, "text-sm"));
  if (repo.runningTask !== null) label.append(line(`running ${repo.runningTask}`, "text-primary"));
  return label;
}

function line(text: string, className: string): HTMLElement {
  const element = document.createElement("div");
  element.textContent = text;
  element.className = className;
  return element;
}
