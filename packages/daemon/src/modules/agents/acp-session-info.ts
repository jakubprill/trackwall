import { type ContextUse, type ConversationMode, SLASH_COMMANDS_MAX, type SlashCommand } from "@trackwall/protocol";
import { z } from "zod";
import type { ConfigOption, SessionUpdate } from "./acp-messages.ts";

/**
 * What the conversation view shows of a session besides its entries (ADR-107): the agent's mode and the ones the user
 * can switch to, how much of the model's context the conversation uses, and the slash commands the agent offers, read
 * from Copilot CLI's `configOptions`, `usage_update` and `available_commands_update` (`contract/acp-session.contract.ts`)
 * and cut to the protocol's limits.
 */

export interface SessionInfo {
  mode: ConversationMode | null;
  context: ContextUse | null;
  commands: SlashCommand[];
}

/** The id of the setting that holds the agent's mode. */
const MODE_SETTING = "mode";

/**
 * Copilot CLI's autopilot turns on its allow-all, which also drops the questions about paths outside the working
 * directory and URLs that the approvals mode `auto` keeps (ADR-105), so the view does not offer it; the user can still
 * turn it on with `/autopilot`, and then the view shows it as the mode it works in.
 */
const AUTOPILOT_MODE = "https://agentclientprotocol.com/protocol/session-modes#autopilot";

const MODE_OPTIONS_MAX = 10;

const ModeOption = z.object({ value: z.string().min(1).max(256), name: z.string(), description: z.string().nullish() });

export class AcpSessionInfo {
  #info: SessionInfo = { mode: null, context: null, commands: [] };

  get(): SessionInfo {
    return this.#info;
  }

  /** Whether the user can switch the agent to `mode`. */
  offers(mode: string): boolean {
    return this.#info.mode?.options.some((o) => o.id === mode) ?? false;
  }

  /** An update of the agent; returns what it changed, `undefined` for nothing. */
  apply(update: SessionUpdate): Partial<SessionInfo> | undefined {
    switch (update.sessionUpdate) {
      case "usage_update":
        return this.#changed({ context: contextUse(update.used, update.size) });
      case "config_option_update":
        return this.settings(update.configOptions);
      case "available_commands_update":
        return this.#changed({ commands: update.availableCommands.flatMap(slashCommand).slice(0, SLASH_COMMANDS_MAX) });
      default:
        return undefined;
    }
  }

  /** The agent's settings, as `session/new`, `session/load` and `session/set_config_option` answer them. */
  settings(options: readonly ConfigOption[] | undefined): Partial<SessionInfo> | undefined {
    const setting = options?.find((o) => o.id === MODE_SETTING);
    if (setting === undefined || typeof setting.currentValue !== "string") return undefined;
    const current = setting.currentValue;
    const modes = (setting.options ?? []).flatMap((o) => {
      const parsed = ModeOption.safeParse(o);
      return parsed.success ? [parsed.data] : [];
    });
    const shown = modes.filter((m) => m.value !== AUTOPILOT_MODE || m.value === current).slice(0, MODE_OPTIONS_MAX);
    const mode: ConversationMode = {
      current: current.slice(0, 256),
      options: shown.map((m) => ({ id: m.value, name: m.name.slice(0, 64), description: (m.description ?? "").slice(0, 1000) })),
    };
    return this.#changed({ mode });
  }

  #changed(change: Partial<SessionInfo>): Partial<SessionInfo> | undefined {
    const next = { ...this.#info, ...change };
    if (JSON.stringify(next) === JSON.stringify(this.#info)) return undefined;
    this.#info = next;
    return change;
  }
}

/** Context use in whole tokens; an agent that says its window has no size says nothing. */
function contextUse(used: number, size: number): ContextUse | null {
  if (!Number.isFinite(used) || !Number.isFinite(size) || size < 1) return null;
  return { used: Math.max(0, Math.round(used)), size: Math.round(size) };
}

type AvailableCommand = Extract<SessionUpdate, { sessionUpdate: "available_commands_update" }>["availableCommands"][number];

function slashCommand(command: AvailableCommand): SlashCommand[] {
  const name = command.name.replace(/^\//, "").slice(0, 64);
  if (name === "") return [];
  return [{ name, description: (command.description ?? "").slice(0, 1000), hint: (command.input?.hint ?? "").slice(0, 200) }];
}
