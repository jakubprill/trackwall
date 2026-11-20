import { Maximize2, Minimize2 } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { clampShare, DEFAULT_PANEL_SHARE, PANEL_SHARE_STEP, panelWidth, readPanelShare, savePanelShare, shareAt } from "@/lib/plan-split";
import { cn } from "@/lib/utils";

const storage = () => window.localStorage;

/**
 * The list of Plan and the selected item or entry beside it (ADR-285), with a divider between them that the user drags,
 * or moves with ← and → once focused, and a double click puts back at half and half; the split is remembered on this
 * computer (`lib/plan-split.ts`). "Read full width" hides the list so long notes read in one comfortable column, and
 * "Show the list" or Esc brings it back.
 */
export function PlanSplit({
  list,
  panel,
  canRead,
  reading,
  onReading,
}: {
  list: ReactNode;
  panel: ReactNode;
  /** Whether the panel shows something worth reading at full width; without it there is no button. */
  canRead: boolean;
  reading: boolean;
  onReading: (reading: boolean) => void;
}) {
  const area = useRef<HTMLDivElement>(null);
  const [areaWidth, setAreaWidth] = useState(0);
  const [share, setShare] = useState(() => readPanelShare(storage));

  useLayoutEffect(() => {
    const node = area.current;
    if (node === null) return;
    const measure = () => setAreaWidth(node.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!reading) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || typesText(e.target)) return;
      e.preventDefault();
      onReading(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [reading, onReading]);

  // What the user left is what they see: a share the minimums overrule is stored as the width it actually gave.
  const choose = (next: number) => {
    const clamped = areaWidth > 0 ? clampShare(panelWidth(areaWidth, next) / areaWidth) : clampShare(next);
    setShare(clamped);
    savePanelShare(storage, clamped);
  };
  const shown = reading && canRead;

  return (
    <div ref={area} className="flex min-h-0 min-w-0">
      <section className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto", shown && "hidden")}>{list}</section>
      {!shown && <Divider share={share} areaWidth={areaWidth} area={area} onShare={setShare} onChosen={choose} />}
      <aside
        aria-label="Selected"
        className={cn("relative min-h-0 shrink-0 overflow-y-auto", shown && "flex-1")}
        style={shown || areaWidth === 0 ? undefined : { width: panelWidth(areaWidth, share) }}
      >
        {canRead && (
          <Button
            variant="ghost"
            size="sm"
            className="absolute top-2 right-2"
            onClick={() => onReading(!shown)}
            title={shown ? "Show the list again (Esc)" : "Read it full width"}
          >
            {shown ? <Minimize2 /> : <Maximize2 />}
            {shown ? "Show the list" : "Read full width"}
          </Button>
        )}
        <div className={cn(shown && "mx-auto w-full max-w-3xl")}>{panel}</div>
      </aside>
    </div>
  );
}

/** The bar between the list and the panel: a separator the pointer drags and the keyboard moves. */
function Divider({
  share,
  areaWidth,
  area,
  onShare,
  onChosen,
}: {
  share: number;
  areaWidth: number;
  area: { current: HTMLDivElement | null };
  /** While dragging: shown, not yet remembered. */
  onShare: (share: number) => void;
  /** Where the user left it: shown and remembered. */
  onChosen: (share: number) => void;
}) {
  const dragging = useRef(false);
  const at = (e: PointerEvent) => {
    const box = area.current?.getBoundingClientRect();
    return box === undefined ? share : shareAt(box.width, e.clientX - box.left);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === "ArrowLeft" ? PANEL_SHARE_STEP : e.key === "ArrowRight" ? -PANEL_SHARE_STEP : 0;
    if (step === 0) return;
    e.preventDefault();
    onChosen(share + step);
  };
  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot take the focus or the pointer, which a splitter needs.
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the panel"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={areaWidth === 0 ? Math.round(share * 100) : Math.round((panelWidth(areaWidth, share) / areaWidth) * 100)}
      tabIndex={0}
      title="Drag to resize, double-click for half and half"
      className="hover:bg-primary/40 focus-visible:bg-primary/40 bg-border w-1 shrink-0 cursor-col-resize touch-none outline-none"
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        e.preventDefault();
      }}
      onPointerMove={(e) => {
        if (dragging.current) onShare(at(e));
      }}
      onPointerUp={(e) => {
        if (!dragging.current) return;
        dragging.current = false;
        onChosen(at(e));
      }}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onDoubleClick={() => onChosen(DEFAULT_PANEL_SHARE)}
      onKeyDown={onKeyDown}
    />
  );
}

/** Whether a key pressed in `target` types into it, so Esc there belongs to the field. */
function typesText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}
