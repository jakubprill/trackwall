import { type ReactNode, useState } from "react";
import { TipCard } from "@/components/TipCard";
import { TIP_IDS, TIPS } from "@/lib/tips";
import { TipsContext, TipsController } from "@/lib/tips-controller";
import type { GalleryState } from "./gallery-state.ts";

const nothing = () => {};

/** Storage as a new computer has it: tips on, none seen; nothing it is given stays. */
const NEW_COMPUTER: Pick<Storage, "getItem" | "setItem"> = { getItem: () => null, setItem: nothing };

/**
 * Tips as a new computer shows them (ADR-296), for a part of a view drawn with its tip. One controller per frame, since
 * a window shows a tip in one place only, and the gallery draws each state several times.
 */
export function NewComputerTips({ children }: { children: ReactNode }) {
  const [tips] = useState(() => new TipsController({ storage: () => NEW_COMPUTER, onStorage: nothing }));
  return <TipsContext.Provider value={tips}>{children}</TipsContext.Provider>;
}

/** Every tip as its place shows it, from the widest text to the shortest. */
const everyTip: GalleryState[] = TIP_IDS.map((tip) => ({
  name: TIPS[tip].label,
  render: () => <TipCard tip={tip} onDocs={nothing} onTurnOff={nothing} onGotIt={nothing} />,
}));

const docsDidNotOpen: GalleryState = {
  name: "Its page did not open",
  render: () => (
    <TipCard
      tip="evidence"
      docsError="Could not open the link: the daemon did not answer: connection refused (127.0.0.1:47823)"
      onDocs={nothing}
      onTurnOff={nothing}
      onGotIt={nothing}
    />
  ),
};

export const TIP_STATES: readonly GalleryState[] = [...everyTip, docsDidNotOpen];
