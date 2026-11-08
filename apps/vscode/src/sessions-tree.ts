import * as vscode from "vscode";
import { type SessionGroup, type SessionRow, sessionGroups } from "./session-groups.ts";
import type { ViewerRead } from "./viewer-client.ts";

/** The "Sessions" side bar: the groups of `sessionGroups`, each session a row that opens it in Trackwall. */

export const OPEN_SESSION_COMMAND = "trackwall.openSession";

type Node = { kind: "group"; group: SessionGroup } | { kind: "session"; row: SessionRow } | { kind: "message"; text: string };

const TONE_COLOURS = { ok: "charts.green", warning: "charts.yellow", error: "charts.red" } as const;

export class SessionsTree implements vscode.TreeDataProvider<Node> {
  readonly #changed = new vscode.EventEmitter<undefined>();
  readonly onDidChangeTreeData = this.#changed.event;
  #read: ViewerRead = { kind: "off" };

  show(read: ViewerRead): void {
    this.#read = read;
    this.#changed.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (node?.kind === "group") return node.group.rows.map((row) => ({ kind: "session", row }));
    if (node) return [];
    // No rows while viewer access is off: the view's welcome text says how to turn it on.
    if (this.#read.kind === "off") return [];
    if (this.#read.kind === "unavailable") return [{ kind: "message", text: this.#read.reason }];
    const groups = sessionGroups(this.#read.list);
    return groups.length === 0 ? [{ kind: "message", text: "No sessions" }] : groups.map((group) => ({ kind: "group", group }));
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === "message") return new vscode.TreeItem(node.text);
    if (node.kind === "group") {
      const item = new vscode.TreeItem(node.group.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(node.group.rows.length);
      item.id = `group:${node.group.id}`;
      return item;
    }
    const { row } = node;
    const item = new vscode.TreeItem(row.label);
    item.id = `session:${row.id}`;
    item.description = row.description;
    item.tooltip = `${row.label}\n${row.description}`;
    item.iconPath =
      row.tone === null
        ? new vscode.ThemeIcon("circle-outline")
        : new vscode.ThemeIcon(row.live ? "circle-filled" : "circle-outline", new vscode.ThemeColor(TONE_COLOURS[row.tone]));
    item.command = { command: OPEN_SESSION_COMMAND, title: "Open in Trackwall", arguments: [row.id] };
    return item;
  }

  dispose(): void {
    this.#changed.dispose();
  }
}
