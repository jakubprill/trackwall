import { type ReactNode, useLayoutEffect, useRef } from "react";
import { readSteadyHeight, saveSteadyHeight } from "@/lib/steady-height";

const storage = () => window.localStorage;

/**
 * A part of a view that loads its data (ADR-264) and must not push what stands under it when the data comes: while
 * `loading` it is at least as tall as it was the last time it showed data, on this computer, also after a restart. The
 * children are the placeholder while loading and the data after; the first time ever, the placeholder's own height
 * stands in. `name` tells the parts apart and is the same wherever the part is drawn.
 */
export function Steady({
  name,
  loading,
  className,
  children,
}: {
  name: string;
  loading: boolean;
  className?: string;
  children: ReactNode;
}) {
  const element = useRef<HTMLDivElement>(null);
  const height = useRef<number | null>(null);
  if (height.current === null) height.current = readSteadyHeight(storage, name);

  useLayoutEffect(() => {
    const node = element.current;
    if (loading || node === null) return;
    const observer = new ResizeObserver(() => {
      const now = Math.round(node.getBoundingClientRect().height);
      if (now === height.current || now === 0) return;
      height.current = now;
      saveSteadyHeight(storage, name, now);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [loading, name]);

  return (
    <div ref={element} className={className} style={loading && height.current !== null ? { minHeight: height.current } : undefined}>
      {children}
    </div>
  );
}
