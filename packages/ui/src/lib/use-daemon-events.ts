import { useEffect, useState } from "react";
import type { Connection } from "./connection.ts";
import { DaemonEvents } from "./daemon-events.ts";

/** One connection to the daemon's events per connection to the daemon; a new connection closes the previous one. */
export function useDaemonEvents(conn: Connection | undefined): DaemonEvents | undefined {
  const [events, setEvents] = useState<DaemonEvents>();
  useEffect(() => {
    if (!conn) return;
    const next = new DaemonEvents({ conn, location: window.location, openSocket: (url, protocols) => new WebSocket(url, protocols) });
    setEvents(next);
    return () => {
      next.close();
      setEvents(undefined);
    };
  }, [conn]);
  return events;
}
