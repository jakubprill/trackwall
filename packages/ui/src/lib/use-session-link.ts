import type { SessionList } from "@trackwall/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionEntry, SessionSelection } from "./session-entries.ts";
import { type SessionLinkTarget, sessionLinkKnown, unknownLinkMessage } from "./session-link.ts";
import { actionIsNewer, type RemoteHandle } from "./use-remote.ts";

/**
 * Shows a `trackwall://` link to a session or task (ADR-52) only once the session list holds it (`sessionLinkKnown`):
 * a target the list does not have yet waits for a list fetched after the link came, and one still missing then gives
 * `notice` instead of a selection. A newer link replaces a waiting one and takes the notice away.
 */
export function useSessionLink(
  sessions: RemoteHandle<SessionList>,
  entries: readonly SessionEntry[],
  open: (selection: SessionSelection) => void,
) {
  const opener = useRef(open);
  opener.current = open;
  const [waiting, setWaiting] = useState<{ target: SessionLinkTarget; afterLoad: number }>();
  const [notice, setNotice] = useState<string>();
  const { data, loadNumber, reload, sentLoads } = sessions;
  const show = (target: SessionLinkTarget) => {
    setNotice(undefined);
    setWaiting(undefined);
    if (sessionLinkKnown(data, entries, target)) return opener.current(target);
    setWaiting({ target, afterLoad: sentLoads() });
    reload();
  };
  useEffect(() => {
    if (!waiting || actionIsNewer(waiting.afterLoad, loadNumber)) return;
    setWaiting(undefined);
    if (sessionLinkKnown(data, entries, waiting.target)) opener.current(waiting.target);
    else setNotice(unknownLinkMessage(waiting.target));
  }, [waiting, data, entries, loadNumber]);
  const dismiss = useCallback(() => setNotice(undefined), []);
  return { show, notice, dismiss };
}
