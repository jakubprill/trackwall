import { SessionId } from "@trackwall/protocol";
import * as vscode from "vscode";
import { statusBarState } from "./session-groups.ts";
import { OPEN_SESSION_COMMAND, SessionsTree } from "./sessions-tree.ts";
import { notSharingMessage, stateFolder } from "./viewer-file.ts";
import { watchSessions } from "./viewer-watch.ts";

/**
 * The Trackwall extension for VS Code (ADR-221): a read-only view of the sessions while the user reads other code. It
 * reads `viewer.json` from Trackwall's state folder and asks the daemon on `127.0.0.1` with the viewer token, which opens
 * the session list alone. A click opens the session in Trackwall's window through its `trackwall://` link (ADR-52); the
 * extension itself never starts, stops or answers anything.
 */

export function activate(context: vscode.ExtensionContext): void {
  const tree = new SessionsTree();
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = "trackwall.showSessions";
  const view = vscode.window.createTreeView("trackwall.sessions", { treeDataProvider: tree });
  const watch = watchSessions({
    folder: () => stateFolder(vscode.workspace.getConfiguration("trackwall").get<string>("stateFolder") ?? ""),
    focused: () => vscode.window.state.focused,
    onRead: (read, folder) => {
      tree.show(read);
      view.message = read.kind === "off" ? notSharingMessage(folder) : undefined;
      const state = statusBarState(read);
      if (!state) return void status.hide();
      status.text = state.text;
      status.tooltip = state.tooltip;
      status.backgroundColor = state.warning ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
      status.show();
    },
  });

  context.subscriptions.push(
    tree,
    status,
    { dispose: watch.dispose },
    view,
    vscode.commands.registerCommand(OPEN_SESSION_COMMAND, (id: unknown) => openSession(id)),
    vscode.commands.registerCommand("trackwall.showSessions", () => vscode.commands.executeCommand("workbench.view.extension.trackwall")),
    vscode.commands.registerCommand("trackwall.refresh", () => watch.refresh()),
    vscode.window.onDidChangeWindowState((state) => {
      if (state.focused) watch.refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("trackwall.stateFolder")) watch.refresh();
    }),
  );
}

/** `trackwall://session/<id>` opens on the computer of the VS Code window, also from a dev container, where Trackwall's window is. */
async function openSession(id: unknown): Promise<void> {
  const session = SessionId.safeParse(id);
  if (!session.success) return;
  const opened = await vscode.env.openExternal(vscode.Uri.parse(`trackwall://session/${session.data}`));
  if (!opened) void vscode.window.showWarningMessage("Trackwall could not be opened: is the Trackwall app installed on this computer?");
}

export function deactivate(): void {}
