import { ptySocket } from "@trackwall/protocol";
import { PtyTerminal, type PtyTerminalWords } from "@/components/PtyTerminal";
import type { Connection } from "@/lib/connection";

const SESSION_WORDS: PtyTerminalWords = {
  noun: "session",
  ended: "The session has ended; the terminal shows what was left on its screen.",
};

/** The session terminal of one session (§4.4, ADR-26): Copilot CLI's TUI in `PtyTerminal`. */
export function SessionTerminal({
  conn,
  session,
  live,
  selected,
}: {
  conn: Connection;
  session: string;
  live: boolean;
  selected: boolean;
}) {
  return <PtyTerminal conn={conn} socket={ptySocket(session)} screenKey={session} live={live} selected={selected} words={SESSION_WORDS} />;
}
