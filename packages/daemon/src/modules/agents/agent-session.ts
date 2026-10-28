import type { DialogAnswer, Session, SessionView } from "@trackwall/protocol";
import type { CopilotHookOutput } from "./copilot-hook-output.ts";
import type { CopilotHookRecord } from "./copilot-hook-record.ts";

/**
 * What `Agents` needs of a session in either view (§4.4): `LiveSession` in a terminal (ADR-26) and `AcpSession` in the
 * conversation view (ADR-107). Only attaching a terminal or a conversation view needs to know which one it is.
 */
export interface AgentSession {
  readonly id: string;
  readonly repo: string | null;
  readonly supervisor: boolean;
  readonly task: string | null;
  /** How the session shows; a restart starts it again in the same view. */
  readonly sessionView: SessionView;
  /** Copilot CLI keeps a conversation the session can go on with (ADR-95). */
  readonly hasConversation: boolean;
  /** Copilot CLI's id of the conversation, once there is one (ADR-107). */
  readonly conversation: string | undefined;
  /** Reads what the session did since the last call; returns whether it is alive. */
  tick(): boolean;
  view(): Session | undefined;
  /** The daemon's prompt for what waits unread goes to the agent as soon as it can take it (ADR-62, ADR-68). */
  askToRead(): "typed" | "queued";
  /** What a hook of the session answers (ADR-85). */
  hookOutput(record: CopilotHookRecord | undefined): CopilotHookOutput;
  answerDialog(id: string, answer: DialogAnswer): void;
  dispose(): void;
}
