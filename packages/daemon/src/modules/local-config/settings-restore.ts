import { KEYS_NOT_RESTORED, type SettingsRestoreItem, type SettingsStoreFolder, TRUST_KEYS, type WorkspaceKey } from "@trackwall/protocol";
import { stringify } from "yaml";
import { messageOf } from "../../infra/errors.ts";
import { fitsMasked, holdsMasked, unmask } from "./secret-masking.ts";
import { maskCopilotFile } from "./settings-copies.ts";

/**
 * What a restore of the settings from the workspace store would change (§4.13, ADR-299), worked out from the store's
 * commit and this computer's files, without touching either. Only what differs is listed. `workspace.yaml` comes back
 * key by key, only the keys the store's copy sets and never those of `KEYS_NOT_RESTORED`; a Copilot CLI file comes back
 * whole, with this computer's values where the store's are masked and everything around them is the same (`unmask`).
 * An agent can commit to the store, so every Copilot CLI file and the keys of `TRUST_KEYS` are marked for a tick of
 * their own, and the text the list shows is masked as the store keeps it, so this computer's tokens never reach it.
 */

const WORKSPACE_FOLDER: SettingsStoreFolder = "trackwall";
const COPILOT_FOLDER: SettingsStoreFolder = "copilot";

/** Where the store keeps `workspace.yaml`. */
export const STORE_WORKSPACE_FILE = `${WORKSPACE_FOLDER}/workspace.yaml`;

/** Where the store keeps a Copilot CLI user file. */
export function storeCopilotFile(file: string): string {
  return `${COPILOT_FOLDER}/${file}`;
}

/** What writing an item takes; `null` for an item with a problem, which is never written. */
type RestoreWrite = { kind: "key"; key: WorkspaceKey; value: unknown } | { kind: "file"; file: string; text: string };

/** An item with what writing it takes. */
export interface PlannedRestore {
  item: SettingsRestoreItem;
  write: RestoreWrite | null;
}

/** The store's `workspace.yaml`: its keys, why it cannot be read, or `null` when the store has none. */
export type StoredWorkspace = { keys: ReadonlyMap<WorkspaceKey, unknown> } | { problem: string } | null;

/** This computer's copy of a Copilot CLI file: its text (`undefined` when missing), or why it cannot be read. */
export type CurrentFile = { text: string | undefined } | { problem: string };

export interface RestoreInputs {
  storedWorkspace: StoredWorkspace;
  currentKeys: ReadonlyMap<WorkspaceKey, unknown>;
  /** Why a value cannot be a key's (`WorkspaceFile.problemOf`). */
  keyProblem: (key: WorkspaceKey, value: unknown) => string | null;
  /** The Copilot CLI files the store has, by file name, and this computer's. */
  storedFiles: ReadonlyMap<string, string>;
  currentFiles: ReadonlyMap<string, CurrentFile>;
}

export function plannedRestores(inputs: RestoreInputs): PlannedRestore[] {
  return [...keyRestores(inputs), ...[...inputs.storedFiles].flatMap(([file, stored]) => fileRestore(file, stored, inputs))];
}

function keyRestores({ storedWorkspace, currentKeys, keyProblem }: RestoreInputs): PlannedRestore[] {
  if (storedWorkspace === null) return [];
  if ("problem" in storedWorkspace) {
    const item = itemOf("workspace", "workspace.yaml", false, { current: null, restored: "", problem: storedWorkspace.problem });
    return [{ item, write: null }];
  }
  const never: readonly string[] = KEYS_NOT_RESTORED;
  const trust: readonly string[] = TRUST_KEYS;
  return [...storedWorkspace.keys].flatMap(([key, value]): PlannedRestore[] => {
    const current = currentKeys.get(key);
    if (never.includes(key) || fitsMasked(value, current)) return [];
    const problem = keyProblem(key, value);
    const shown = { current: current === undefined ? null : stringify({ [key]: current }), restored: stringify({ [key]: value }), problem };
    const item = itemOf(`workspace:${key}`, `${key} in workspace.yaml`, trust.includes(key), shown);
    return [{ item, write: problem === null ? { kind: "key", key, value } : null }];
  });
}

function fileRestore(file: string, stored: string, { currentFiles }: RestoreInputs): PlannedRestore[] {
  const current = currentFiles.get(file) ?? { text: undefined };
  const id = `copilot:${file}`;
  if ("problem" in current) {
    const problem = `this computer's ${file} cannot be read: ${current.problem}`;
    return [{ item: itemOf(id, file, true, { current: null, restored: shownAsStored(file, stored), problem }, stored), write: null }];
  }
  const restored = restoredText(file, stored, current.text);
  if (restored.same) return [];
  // The store's side is shown as the store has it: it holds no token of this computer, and an agent's literal value in
  // it (an env value, a header) must be seen before it is ticked. Where a unit took this computer's values, the store's
  // masked unit is what the list shows, and this computer's side is masked the same way, so the two lines match.
  const shown = {
    current: current.text === undefined ? null : shownMasked(file, current.text),
    restored: shownAsStored(file, stored),
    problem: null,
  };
  return [{ item: itemOf(id, file, true, shown, restored.text), write: { kind: "file", file, text: restored.text } }];
}

function itemOf(
  id: string,
  label: string,
  trust: boolean,
  shown: { current: string | null; restored: string; problem: string | null },
  written = shown.restored,
): SettingsRestoreItem {
  return { id, label, trust, ...shown, stillMasked: holdsMasked(written) };
}

/**
 * The text a restore writes, and whether it is what this computer already has. A JSON file is unmasked by unit, a
 * server of `mcp-config.json` or a key of `settings.json`, and compared by value, so a file only formatted otherwise
 * is not listed; it keeps the store's bytes unless a unit took this computer's values.
 */
function restoredText(file: string, stored: string, current: string | undefined): { text: string; same: boolean } {
  if (!file.endsWith(".json")) return { text: stored, same: stored === current };
  const parsedStored = parseOrUndefined(stored);
  const parsedCurrent = current === undefined ? undefined : parseOrUndefined(current);
  if (parsedStored === undefined) return { text: stored, same: stored === current };
  const restored = file === "mcp-config.json" ? unmaskServers(parsedStored, parsedCurrent) : unmaskUnits(parsedStored, parsedCurrent);
  const same = current !== undefined && fitsMasked(restored, parsedCurrent);
  return { text: fitsMasked(restored, parsedStored) ? stored : pretty(restored), same };
}

/** `mcp-config.json` with each server unmasked on its own: a server whose address or command changed keeps its masks. */
function unmaskServers(stored: unknown, current: unknown): unknown {
  if (!isRecord(stored) || !isRecord(stored.mcpServers)) return stored;
  const here = isRecord(current) && isRecord(current.mcpServers) ? current.mcpServers : {};
  return { ...stored, mcpServers: unmaskUnits(stored.mcpServers, here) };
}

/** An object with each of its values unmasked on its own. */
function unmaskUnits(stored: unknown, current: unknown): unknown {
  if (!isRecord(stored)) return unmask(stored, current);
  const here = isRecord(current) ? new Map(Object.entries(current)) : new Map<string, unknown>();
  return Object.fromEntries(Object.entries(stored).map(([key, value]) => [key, unmask(value, here.get(key))]));
}

/** The store's text, formatted as `shownMasked` formats this computer's, so the lines of the two sides line up. */
function shownAsStored(file: string, stored: string): string {
  const parsed = file.endsWith(".json") ? parseOrUndefined(stored) : undefined;
  return parsed === undefined ? stored : pretty(parsed);
}

/** A file's text masked as the store keeps it, for the list; a note in its place when its secrets cannot be found. */
function shownMasked(file: string, text: string): string {
  try {
    const masked = maskCopilotFile(file, Buffer.from(text, "utf8")).toString("utf8");
    const parsed = file.endsWith(".json") ? parseOrUndefined(masked) : undefined;
    return parsed === undefined ? masked : pretty(parsed);
  } catch (err) {
    return `(${file} is not shown, since its secrets cannot be masked: ${messageOf(err)})\n`;
  }
}

function pretty(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function parseOrUndefined(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
