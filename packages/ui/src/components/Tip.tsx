import { useEffect, useId, useRef } from "react";
import { TipCard } from "@/components/TipCard";
import { docsUrl } from "@/lib/config-files";
import type { Connection } from "@/lib/connection";
import { useOpenWebLink } from "@/lib/desktop";
import { TIPS, type TipId } from "@/lib/tips";
import { useTips } from "@/lib/tips-controller";
import { useAction } from "@/lib/use-action";

/**
 * The place of a tip (ADR-296), right under the control it explains: it tells the window's tips that the control is on
 * screen, and shows the tip when the window picks this place for it. A tip that "Show" of What's new asked for comes
 * into sight, since the user is looking for it.
 */
export function Tip({ conn, tip, className }: { conn: Connection; tip: TipId; className?: string }) {
  const { tips, state } = useTips();
  const place = useId();
  useEffect(() => tips?.enter(tip, place), [tips, tip, place]);
  const openLink = useOpenWebLink(conn);
  const docs = useAction(
    () => openLink(docsUrl(TIPS[tip].docs.page)),
    () => {},
  );
  const card = useRef<HTMLElement>(null);
  const shown = state.shown?.place === place ? state.shown : null;
  const asked = shown?.asked === true;
  useEffect(() => {
    if (asked) card.current?.scrollIntoView({ block: "nearest" });
  }, [asked]);
  if (!tips || !shown) return null;
  return (
    <TipCard
      ref={card}
      tip={tip}
      className={className}
      docsError={docs.error}
      onDocs={docs.run}
      onTurnOff={() => tips.setOn(false)}
      onGotIt={() => tips.gotIt(tip)}
    />
  );
}
