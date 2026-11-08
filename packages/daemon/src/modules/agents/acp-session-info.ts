import { type ContextUse, type ConversationInfo, type ConversationMode, SLASH_COMMANDS_MAX, type SlashCommand } from "@trackwall/protocol";
import { z } from "zod";
import type { ConfigOption, SessionUpdate } from "./acp-messages.ts";

/**
 * What the conversation view shows of a session besides its entries (ADR-107): the agent's mode and the ones the user
 * can switch to, how much of the model's context the conversation uses, and the slash commands the agent offers, read
 * from Copilot CLI's `configOptions`, `usage_update` and `available_commands_update` (`contract/acp-session.contract.ts`)
 * and cut to the protocol's limits.
 */

/** Copilot CLI's Agent mode, in which the agent changes files and runs tools. */
export const AGENT_MODE = "https://agentclientprotocol.com/protocol/session-modes#agent";
/** Copilot CLI's Plan mode, in which it refuses to change files and writes a plan instead (ADR-227). */
export const PLAN_MODE = "https://agentclientprotocol.com/protocol/session-modes#plan";

/** The id of the setting that holds the agent's mode. */
const MODE_SETTING = "mode";

/**
 * The modes the user can switch to, by Copilot CLI's ids (`contract/acp-session.contract.ts`). An allowlist, not a list
 * of what to hide: Copilot CLI's autopilot turns on its allow-all, which also drops the questions about paths outside
 * the working directory and URLs that the approvals mode `auto` keeps (ADR-105), and a mode Copilot CLI adds later may do
 * the same. The user can still turn autopilot on with `/autopilot`, and then the view shows it as the mode in use.
 */
const SWITCHABLE_MODES: ReadonlySet<string> = new Set([AGENT_MODE, PLAN_MODE]);

const MODE_OPTIONS_MAX = 10;

const ModeOption = z.object({ value: z.string().min(1).max(256), name: z.string(), description: z.string().nullish() });

export class AcpSessionInfo {
  #info: ConversationInfo = { mode: null, context: null, commands: [] };

  get(): ConversationInfo {
    return this.#info;
  }

  /** Whether the user can switch the agent to `mode`: a switchable mode the agent offers. */
  offers(mode: string): boolean {
    return SWITCHABLE_MODES.has(mode) && (this.#info.mode?.options.some((o) => o.id === mode) ?? false);
  }

  /** An update of the agent; returns what it changed, `undefined` for nothing. */
  apply(update: SessionUpdate): Partial<ConversationInfo> | undefined {
    switch (update.sessionUpdate) {
      case "usage_update":
        return this.#changed({ context: contextUse(update.used, update.size) });
      case "config_option_update":
        return this.settings(update.configOptions);
      case "available_commands_update":
        return this.#changed({ commands: slashCommands(update.availableCommands) });
      default:
        return undefined;
    }
  }

  /** The agent's settings, as `session/new`, `session/load` and `session/set_config_option` answer them. */
  settings(options: readonly ConfigOption[] | undefined): Partial<ConversationInfo> | undefined {
    const setting = options?.find((o) => o.id === MODE_SETTING);
    if (setting === undefined || typeof setting.currentValue !== "string") return undefined;
    const current = setting.currentValue;
    const modes = (setting.options ?? []).flatMap((o) => {
      const parsed = ModeOption.safeParse(o);
      return parsed.success ? [parsed.data] : [];
    });
    // The mode in use shows also when it cannot be switched to, so the switch never hides how the agent works.
    const shown = modes.filter((m) => SWITCHABLE_MODES.has(m.value) || m.value === current).slice(0, MODE_OPTIONS_MAX);
    const mode: ConversationMode = {
      current: current.slice(0, 256),
      options: shown.map((m) => ({ id: m.value, name: m.name.slice(0, 64), description: (m.description ?? "").slice(0, 1000) })),
    };
    return this.#changed({ mode });
  }

  /** `change` holds one part of the info; it is a change when that part differs. */
  #changed(change: Partial<ConversationInfo>): Partial<ConversationInfo> | undefined {
    const same = Object.entries(change).every(([key, value]) => JSON.stringify(value) === JSON.stringify(Reflect.get(this.#info, key)));
    if (same) return undefined;
    this.#info = { ...this.#info, ...change };
    return change;
  }
}

/** Context use in whole tokens; an agent that says its window has no size says nothing. */
function contextUse(used: number, size: number): ContextUse | null {
  if (!Number.isFinite(used) || !Number.isFinite(size) || size < 1) return null;
  return { used: Math.max(0, Math.round(used)), size: Math.round(size) };
}

type AvailableCommand = Extract<SessionUpdate, { sessionUpdate: "available_commands_update" }>["availableCommands"][number];

/** The commands with names, each name once (the view keys its list by them), cut to the protocol's limits. */
function slashCommands(commands: readonly AvailableCommand[]): SlashCommand[] {
  const byName = new Map<string, SlashCommand>();
  for (const command of commands) {
    const name = command.name.replace(/^\//, "").slice(0, 64);
    if (name === "" || byName.has(name)) continue;
    byName.set(name, { name, description: (command.description ?? "").slice(0, 1000), hint: (command.input?.hint ?? "").slice(0, 200) });
  }
  return [...byName.values()].slice(0, SLASH_COMMANDS_MAX);
}
