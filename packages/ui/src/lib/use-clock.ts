import { useEffect, useState } from "react";

/** The time now, read again every `everyMs`, so a time on the screen moves on while nothing else changes. */
export function useClock(everyMs: number): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
